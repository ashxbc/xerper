/**
 * Telegram bot: the complete project-listing workflow.
 *
 * A user pastes a project link (tweet / page) or plain text; the bot extracts
 * the content (the full thread for tweets, crawl4ai for other pages), runs it
 * through Groq to produce the listing data (project name, task, campaign
 * details, steps), and then walks the user through editing and confirming it
 * with inline buttons - entirely inside Telegram. Only when the user confirms
 * is the project written to Supabase (status 'added'), which makes it appear
 * on the website through the existing /api/gems integration.
 *
 * Flow
 * ----
 *   1. paste link/text          -> Groq extracts  name / task / details / steps
 *   2. buttons: Edit | List | Cancel
 *        Edit  -> task, details, or steps (steps: add / remove / modify, max 6)
 *                 editing stays available until List or Cancel
 *        List  -> bot asks for the project's X handle, then fetches its PFP
 *   3. preview (PFP + all data) -> buttons: List | Cancel
 *   4. List -> validate, insert into Supabase, reply "Listed successfully."
 *
 * Sessions are persisted to .telegram-bot-state.json (gitignored), so an
 * in-flight listing survives a bot restart and can be resumed.
 *
 * Text extraction by input type:
 *   - tweet URLs -> fetched through the dedicated discovery burner
 *     (X_DISCOVERY_AUTH_TOKEN / X_DISCOVERY_CT0) via XSearch.fetchStatusThread,
 *     which reads the tweet AND its thread off the status page. Never uses
 *     crawl4ai.
 *   - any other URL -> crawl4ai (unclecode/crawl4ai) via scripts/crawl.py - a
 *     real headless browser with stealth mode. Falls back to a plain HTML
 *     stripper when Python/crawl4ai isn't installed.
 *   - plain pasted text -> sent to Groq as-is.
 *
 * Usage
 * -----
 *   npx tsx --env-file=.env.local scripts/telegram-bot.ts
 *
 * Env vars (from .env.local):
 *   TELEGRAM_BOT_TOKEN        bot token from @BotFather (required)
 *   GROQ_API_KEY              Groq key (required; TELEGRAM_GROQ_API_KEY wins
 *                             over it if both are set)
 *   X_DISCOVERY_AUTH_TOKEN    discovery burner for tweet extraction + PFP
 *   X_DISCOVERY_CT0           lookups (same pair the NFT scan uses)
 *   NEXT_PUBLIC_SUPABASE_URL  required to list projects (the insert writes
 *   SUPABASE_SERVICE_ROLE_KEY straight to Supabase from this process)
 *   PYTHON_BIN                python executable for crawl4ai (default "python")
 *   TELEGRAM_ALLOWED_IDS      optional comma-separated chat IDs allowed to use
 *                             the bot; when unset, anyone who finds the bot
 *                             can use it (and spend your Groq quota)
 *
 * crawl4ai setup (one time):
 *   pip install -U crawl4ai
 *   crawl4ai-setup            # installs Playwright Chromium
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { Telegraf, Markup, type Context } from "telegraf";

import {
  extractListingFromText,
  type ListingExtraction,
} from "../src/lib/groq";
import { listProjectViaTelegram } from "../src/lib/projects-store";
import {
  acquireDiscoveryAccount,
  isDiscoveryConfigured,
  reportDiscoveryRateLimited,
} from "../src/lib/x/accounts";
import { AuthFailed, RateLimited, XSearch, type UserFields } from "../src/lib/x/search";

const execFileAsync = promisify(execFile);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20_000;
// Crawl4AI needs longer - browser launch + render can take a while.
const CRAWL_TIMEOUT_MS = 90_000;
// Groq input cap - plenty for a thread or a page's main content.
const MAX_INPUT_CHARS = 12_000;

// Listing limits (enforced on user edits, and re-enforced after Groq).
const MAX_STEPS = 6;
const MAX_DETAILS_WORDS = 50;
const MAX_STEP_CHARS = 120;
const MAX_TASK_CHARS = 200;
const HANDLE_RE = /^@?([A-Za-z0-9_]{1,15})$/;

// ---- validation ------------------------------------------------------------

function parseHandle(input: string): string | null {
  const match = input.trim().match(HANDLE_RE);
  return match ? match[1] : null;
}

/** Returns an error message when the value is invalid, null when OK. */
function validateTask(task: string): string | null {
  if (!task.trim()) return "The task cannot be empty.";
  if (task.length > MAX_TASK_CHARS) {
    return `The task is too long (max ${MAX_TASK_CHARS} characters).`;
  }
  return null;
}

function validateDetails(details: string): string | null {
  if (!details.trim()) return "Campaign details cannot be empty.";
  const words = details.trim().split(/\s+/).filter(Boolean).length;
  if (words > MAX_DETAILS_WORDS) {
    return `Campaign details must be at most ${MAX_DETAILS_WORDS} words (currently ${words}).`;
  }
  return null;
}

function validateStep(step: string): string | null {
  if (!step.trim()) return "A step cannot be empty.";
  if (step.length > MAX_STEP_CHARS) {
    return `A step is too long (max ${MAX_STEP_CHARS} characters).`;
  }
  return null;
}

// ---- session state ---------------------------------------------------------

// The bot's working draft: Groq's extraction plus the campaign link the user
// provides after the X handle (optional - skipped with the Skip button).
type ListingDraft = ListingExtraction & { campaign_url: string };

type Session =
  | { phase: "idle" }
  | { phase: "draft"; draft: ListingDraft }
  | { phase: "edit_task"; draft: ListingDraft }
  | { phase: "edit_details"; draft: ListingDraft }
  | { phase: "edit_step_add"; draft: ListingDraft }
  | { phase: "edit_step_replace"; draft: ListingDraft; index: number }
  | { phase: "awaiting_handle"; draft: ListingDraft }
  | { phase: "awaiting_link"; draft: ListingDraft; profile: UserFields }
  | { phase: "confirm"; draft: ListingDraft; profile: UserFields };

const sessions = new Map<number, Session>();

// Sessions survive bot restarts: the active draft of each chat is written to
// a gitignored JSON file on every change and reloaded on boot, so a listing
// in progress can be resumed without leaving Telegram.
const STATE_FILE = fileURLToPath(
  new URL("../.telegram-bot-state.json", import.meta.url),
);

function serializeSessions(): string {
  const entries: Record<string, Session> = {};
  for (const [chatId, session] of sessions) {
    if (session.phase !== "idle") entries[String(chatId)] = session;
  }
  return JSON.stringify({ sessions: entries }, null, 2);
}

let saveTimer: NodeJS.Timeout | null = null;
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeFile(STATE_FILE, serializeSessions(), "utf8").catch((error) => {
      console.warn("[telegram-bot] failed to persist sessions:", error?.message ?? error);
    });
  }, 400);
}

async function loadSessions(): Promise<void> {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as { sessions?: Record<string, Session> };
    for (const [chatId, session] of Object.entries(parsed.sessions ?? {})) {
      if (session && typeof session === "object" && "phase" in session) {
        sessions.set(Number(chatId), session);
      }
    }
    if (sessions.size > 0) {
      console.log(`[telegram-bot] resumed ${sessions.size} in-flight session(s)`);
    }
  } catch {
    // No state file yet - first run, or nothing in progress.
  }
}

function setSession(chatId: number, session: Session): void {
  sessions.set(chatId, session);
  scheduleSave();
}

function getSession(chatId: number): Session {
  return sessions.get(chatId) ?? { phase: "idle" };
}

function clearSession(chatId: number): void {
  sessions.delete(chatId);
  scheduleSave();
}

// ---- text extraction -------------------------------------------------------

/** Crawl a URL with crawl4ai via scripts/crawl.py. Returns the clean markdown
 *  or throws with a helpful message. */
async function crawlWithCrawl4ai(url: string): Promise<string> {
  const pythonBin = (process.env.PYTHON_BIN ?? "python").trim();
  const scriptPath = fileURLToPath(new URL("./crawl.py", import.meta.url));

  const { stdout, stderr } = await execFileAsync(pythonBin, [scriptPath, url], {
    timeout: CRAWL_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });

  let parsed: {
    ok?: boolean;
    markdown?: string | null;
    error?: string | null;
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const detail = (stderr || stdout).slice(0, 300);
    throw new Error(`crawl4ai produced unreadable output: ${detail}`);
  }

  if (!parsed.ok || !parsed.markdown) {
    throw new Error(parsed.error || "crawl4ai returned no content");
  }
  return parsed.markdown;
}

/** Fetch a tweet URL's thread through the dedicated discovery burner. Uses
 *  XSearch.fetchStatusThread (the session-authenticated status page, which
 *  embeds the whole conversation) - never crawl4ai for tweets. Handles the
 *  discovery account's 429 cooldown and reports it back to the caller. */
async function fetchTweetThread(url: string): Promise<string> {
  if (!isDiscoveryConfigured()) {
    throw new Error(
      "No discovery session configured - set X_DISCOVERY_AUTH_TOKEN and " +
        "X_DISCOVERY_CT0 to fetch tweets",
    );
  }

  const account = await acquireDiscoveryAccount();
  const client = new XSearch(account.authToken, account.ct0);
  try {
    return await client.fetchStatusThread(url);
  } catch (error) {
    if (error instanceof RateLimited) {
      reportDiscoveryRateLimited();
      throw new Error(
        "X rate-limited the discovery account - try again in a few minutes",
      );
    }
    if (error instanceof AuthFailed) {
      throw new Error(
        "X rejected the discovery session - refresh X_DISCOVERY_AUTH_TOKEN and " +
          "X_DISCOVERY_CT0 from a logged-in browser",
      );
    }
    throw error;
  }
}

/** Strip markup and boilerplate from a generic web page, returning its main
 *  readable text. Last-resort fallback when crawl4ai isn't available -
 *  deliberately simple: script/style/svg are removed, tags are unwrapped, and
 *  long runs of whitespace collapse. */
function extractPageText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPageText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Page returned HTTP ${res.status}`);
  const html = await res.text();
  const text = extractPageText(html);
  if (!text) throw new Error("The page contained no readable text");
  return text;
}

const URL_RE = /https?:\/\/[^\s]+/;
const TWEET_RE = /(?:twitter|x|vxtwitter|fxtwitter)\.com\/\w+\/status\/\d+/i;

/** Turn a user's message into plain text. Tweets go through the discovery
 *  burner (never crawl4ai); other URLs go through crawl4ai with a plain-HTTP
 *  fallback for when Python isn't installed. */
async function resolveMessageText(message: string): Promise<string> {
  const urlMatch = message.match(URL_RE);
  if (!urlMatch) return message.trim();

  const url = urlMatch[0].replace(/[),.;!?]+$/, "");

  if (TWEET_RE.test(url)) {
    return (await fetchTweetThread(url)).slice(0, MAX_INPUT_CHARS);
  }

  try {
    const markdown = await crawlWithCrawl4ai(url);
    return markdown.slice(0, MAX_INPUT_CHARS);
  } catch (crawlError) {
    // Fall back to plain HTTP extraction when crawl4ai isn't available.
    console.warn(
      "[telegram-bot] crawl4ai unavailable, falling back to HTTP:",
      crawlError instanceof Error ? crawlError.message : crawlError,
    );
    return (await fetchPageText(url)).slice(0, MAX_INPUT_CHARS);
  }
}

// ---- profile fetch (X handle + PFP) ----------------------------------------

/** Resolve a handle to its full X profile (PFP, banner, bio, followers, ...)
 *  through the dedicated discovery burner. */
async function fetchProfileByHandle(handle: string): Promise<UserFields> {
  if (!isDiscoveryConfigured()) {
    throw new Error(
      "No discovery session configured - set X_DISCOVERY_AUTH_TOKEN and " +
        "X_DISCOVERY_CT0 to look up profiles",
    );
  }

  const account = await acquireDiscoveryAccount();
  const client = new XSearch(account.authToken, account.ct0);
  try {
    const profile = await client.userByScreenName(handle);
    if (!profile) {
      throw new Error(`No profile found for @${handle} on X - check the handle`);
    }
    return profile;
  } catch (error) {
    if (error instanceof RateLimited) {
      reportDiscoveryRateLimited();
      throw new Error(
        "X rate-limited the discovery account - try again in a few minutes",
      );
    }
    if (error instanceof AuthFailed) {
      throw new Error(
        "X rejected the discovery session - refresh X_DISCOVERY_AUTH_TOKEN and " +
          "X_DISCOVERY_CT0 from a logged-in browser",
      );
    }
    throw error;
  }
}

// ---- rendering -------------------------------------------------------------

/** Escape text for Telegram's legacy Markdown parse mode. */
function esc(value: string): string {
  return value.replace(/([_*`[])/g, "\\$1");
}

function renderDraft(draft: ListingDraft): string {
  const lines = [
    `🏷️ *${esc(draft.project_name || "Unknown")}*`,
    "",
    `🎯 *Task*`,
    esc(draft.task || "—"),
    "",
    `📋 *Campaign details*`,
    esc(draft.details || "—"),
    "",
    `💰 *Prize pool:* ${esc(draft.prize_pool || "Not stated")}`,
    "",
    `🪜 *Steps*`,
  ];
  if (draft.steps.length === 0) {
    lines.push(esc("(none yet)"));
  } else {
    draft.steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${esc(step)}`);
    });
  }
  return lines.join("\n");
}

function draftKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✏️ Edit", "edit"),
      Markup.button.callback("✅ List", "list"),
      Markup.button.callback("❌ Cancel", "cancel"),
    ],
  ]);
}

function editMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✏️ Task", "edit:task"),
      Markup.button.callback("✏️ Details", "edit:details"),
      Markup.button.callback("✏️ Steps", "edit:steps"),
    ],
    [
      Markup.button.callback("⬅️ Back", "edit"),
      Markup.button.callback("❌ Cancel", "cancel"),
    ],
  ]);
}

function stepsMenuKeyboard(stepCount: number) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("➕ Add step", "steps:add"),
      Markup.button.callback("🗑 Remove", "steps:remove"),
    ],
    stepCount > 0
      ? Array.from({ length: stepCount }, (_, i) =>
          Markup.button.callback(`✏️ ${i + 1}`, `step:edit:${i}`),
        )
      : [],
    [
      Markup.button.callback("⬅️ Back", "edit"),
      Markup.button.callback("❌ Cancel", "cancel"),
    ],
  ]);
}

function stepsRemoveKeyboard(stepCount: number) {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < stepCount; i += 2) {
    rows.push([
      Markup.button.callback(`🗑 ${i + 1}`, `step:remove:${i}`),
      i + 1 < stepCount
        ? Markup.button.callback(`🗑 ${i + 2}`, `step:remove:${i + 1}`)
        : Markup.button.callback(" ", "noop"),
    ]);
  }
  rows.push([
    Markup.button.callback("⬅️ Back", "edit:steps"),
    Markup.button.callback("❌ Cancel", "cancel"),
  ]);
  return Markup.inlineKeyboard(rows);
}

function cancelOnlyKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("❌ Cancel", "cancel")],
  ]);
}

function linkSkipKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("⏭️ Skip", "skip:link"),
      Markup.button.callback("❌ Cancel", "cancel"),
    ],
  ]);
}

function confirmKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ List", "confirm:list"),
      Markup.button.callback("❌ Cancel", "cancel"),
    ],
  ]);
}

/** Render the numbered steps into a message for the edit/remove menus. */
function renderStepsList(steps: string[]): string {
  if (steps.length === 0) return "No steps yet.";
  return steps.map((step, index) => `${index + 1}. ${esc(step)}`).join("\n");
}

// ---- bot -------------------------------------------------------------------

async function main(): Promise<void> {
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!token) {
    console.error(
      "TELEGRAM_BOT_TOKEN is not set - create a bot with @BotFather and add the token to .env.local",
    );
    process.exit(1);
  }

  // Optional allowlist - protects the Groq quota from strangers.
  const allowedIds = new Set(
    (process.env.TELEGRAM_ALLOWED_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );

  await loadSessions();

  const bot = new Telegraf(token);

  const allowed = (chatId: number): boolean =>
    allowedIds.size === 0 || allowedIds.has(String(chatId));

  bot.start(async (ctx) => {
    clearSession(ctx.chat.id);
    await ctx.reply(
      "Welcome! Send me a project link (tweet or website) or paste any text, " +
        "and I'll turn it into a campaign listing - project name, task, " +
        "campaign details, and steps. You can edit everything before listing.",
    );
  });

  bot.help(async (ctx) => {
    await ctx.reply(
      "Send a project link or text to start a listing.\n\n" +
        "Commands:\n" +
        "/start - reset and start over\n" +
        "/cancel - cancel the current listing\n\n" +
        "The listing flow:\n" +
        "1. Paste a tweet URL, any link, or plain text - I extract the data\n" +
        "2. Edit task / details / steps (up to 6 steps) if needed\n" +
        "3. Press List and send the project's X handle\n" +
        "4. Confirm the preview - the project is then stored and appears on the site",
    );
  });

  bot.command("cancel", async (ctx) => {
    clearSession(ctx.chat.id);
    await ctx.reply("Cancelled. Send a new link to start another listing.");
  });

  /** Start a fresh listing from raw message text: resolve the content, run
   *  Groq, then show the draft with Edit/List/Cancel. */
  async function startListing(ctx: Context, raw: string) {
    if (!ctx.chat) return;
    const chatId = ctx.chat.id;
    await ctx.replyWithChatAction("typing");
    try {
      const text = await resolveMessageText(raw);
      const extracted = await extractListingFromText(text);
      const draft: ListingDraft = { ...extracted, campaign_url: "" };
      setSession(chatId, { phase: "draft", draft });
      await ctx.reply(renderDraft(draft), {
        parse_mode: "Markdown",
        ...draftKeyboard(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[telegram-bot]", message);
      await ctx
        .reply(`⚠️ Could not process that: ${message}\n\nSend a new link to try again.`)
        .catch(() => {});
    }
  }

  /** Show the final preview (draft + X handle + campaign link) with the
   *  List/Cancel confirmation buttons. */
  async function showConfirm(ctx: Context, draft: ListingDraft, profile: UserFields) {
    const preview =
      renderDraft(draft) +
      "\n\n" +
      `🐦 *X:* @${profile.screen_name || ""}` +
      (draft.campaign_url ? `\n🔗 *Campaign link:* ${esc(draft.campaign_url)}` : "");
    if (profile.avatar) {
      await ctx
        .replyWithPhoto(profile.avatar, {
          caption: preview,
          parse_mode: "Markdown",
          ...confirmKeyboard(),
        })
        .catch(() =>
          ctx.reply(preview, {
            parse_mode: "Markdown",
            ...confirmKeyboard(),
          }),
        );
    } else {
      await ctx.reply(preview, {
        parse_mode: "Markdown",
        ...confirmKeyboard(),
      });
    }
  }

  bot.on("text", async (ctx) => {
    if (!allowed(ctx.chat.id)) {
      return ctx.reply("Sorry, this bot is restricted to approved users.");
    }

    const chatId = ctx.chat.id;
    const session = getSession(chatId);

    // A URL always starts a new listing - except while we are explicitly
    // asking for the campaign link, where the URL is the answer.
    if (session.phase !== "awaiting_link" && URL_RE.test(ctx.message.text)) {
      clearSession(chatId);
      return startListing(ctx, ctx.message.text);
    }

    switch (session.phase) {
      case "idle":
        return startListing(ctx, ctx.message.text);

      case "draft":
        // Editing happens through the buttons; a stray message is ignored.
        return ctx.reply("Use the buttons below to edit, list, or cancel.");

      case "edit_task": {
        const error = validateTask(ctx.message.text);
        if (error) return ctx.reply(`⚠️ ${error} Send the task again, or press Cancel.`);
        const draft = { ...session.draft, task: ctx.message.text.trim() };
        setSession(chatId, { phase: "draft", draft });
        return ctx.reply(renderDraft(draft), {
          parse_mode: "Markdown",
          ...draftKeyboard(),
        });
      }

      case "edit_details": {
        const error = validateDetails(ctx.message.text);
        if (error) return ctx.reply(`⚠️ ${error} Send the details again, or press Cancel.`);
        const draft = { ...session.draft, details: ctx.message.text.trim() };
        setSession(chatId, { phase: "draft", draft });
        return ctx.reply(renderDraft(draft), {
          parse_mode: "Markdown",
          ...draftKeyboard(),
        });
      }

      case "edit_step_add": {
        if (session.draft.steps.length >= MAX_STEPS) {
          setSession(chatId, { phase: "draft", draft: session.draft });
          return ctx.reply(renderDraft(session.draft), {
            parse_mode: "Markdown",
            ...draftKeyboard(),
          });
        }
        const error = validateStep(ctx.message.text);
        if (error) return ctx.reply(`⚠️ ${error} Send the step again, or press Cancel.`);
        const draft = {
          ...session.draft,
          steps: [...session.draft.steps, ctx.message.text.trim()],
        };
        setSession(chatId, { phase: "draft", draft });
        return ctx.reply(renderDraft(draft), {
          parse_mode: "Markdown",
          ...draftKeyboard(),
        });
      }

      case "edit_step_replace": {
        const error = validateStep(ctx.message.text);
        if (error) return ctx.reply(`⚠️ ${error} Send the step again, or press Cancel.`);
        const steps = [...session.draft.steps];
        steps[session.index] = ctx.message.text.trim();
        const draft = { ...session.draft, steps };
        setSession(chatId, { phase: "draft", draft });
        return ctx.reply(renderDraft(draft), {
          parse_mode: "Markdown",
          ...draftKeyboard(),
        });
      }

      case "awaiting_handle": {
        const handle = parseHandle(ctx.message.text);
        if (!handle) {
          return ctx.reply(
            "⚠️ That doesn't look like an X handle. Send it like @ProjectName " +
              "or ProjectName, or press Cancel.",
          );
        }
        await ctx.replyWithChatAction("typing");
        try {
          const profile = await fetchProfileByHandle(handle);
          setSession(chatId, {
            phase: "awaiting_link",
            draft: session.draft,
            profile,
          });
          await ctx.reply(
            "Send the campaign link (https://...) or press Skip:",
            linkSkipKeyboard(),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[telegram-bot]", message);
          // Stay in awaiting_handle so the user can fix the handle or cancel.
          await ctx
            .reply(
              `⚠️ ${message}\n\nSend the X handle again, or press Cancel.`,
              cancelOnlyKeyboard(),
            )
            .catch(() => {});
        }
        return;
      }

      case "awaiting_link": {
        // A URL here is the campaign link (never a new listing - the URL
        // interception above already exempts this phase).
        const url = ctx.message.text.trim();
        if (!URL_RE.test(url)) {
          return ctx.reply(
            "⚠️ That doesn't look like a valid link. Send a full URL " +
              "(https://...), or press Skip.",
          );
        }
        const draft = { ...session.draft, campaign_url: url };
        setSession(chatId, {
          phase: "confirm",
          draft,
          profile: session.profile,
        });
        return showConfirm(ctx, draft, session.profile);
      }

      case "confirm":
        return ctx.reply("Use the buttons below to list or cancel.");
    }
  });

  // ---- inline buttons ------------------------------------------------------

  bot.action(/^step:(edit|remove):(\d+)$/, async (ctx) => {
    if (!ctx.chat) return ctx.answerCbQuery();
    if (!allowed(ctx.chat.id)) return ctx.answerCbQuery("Not allowed.");
    const chatId = ctx.chat.id;
    const session = getSession(chatId);
    if (session.phase !== "draft") {
      await ctx.answerCbQuery("This listing is no longer active.");
      return;
    }
    const kind = ctx.match[1] as "edit" | "remove";
    const index = Number(ctx.match[2]);

    if (kind === "remove") {
      const steps = session.draft.steps.filter((_, i) => i !== index);
      const draft = { ...session.draft, steps };
      setSession(chatId, { phase: "draft", draft });
      await ctx.answerCbQuery("Step removed.");
      return ctx.editMessageText(
        `*Steps*\n\n${renderStepsList(draft.steps)}\n\nChoose what to do:`,
        {
          parse_mode: "Markdown",
          ...stepsMenuKeyboard(draft.steps.length),
        },
      );
    }

    // Edit step <index> - consume the next text message.
    setSession(chatId, {
      phase: "edit_step_replace",
      draft: session.draft,
      index,
    });
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      `Send the new text for step ${index + 1}:\n\n${renderStepsList(session.draft.steps)}`,
      {
        parse_mode: "Markdown",
        ...cancelOnlyKeyboard(),
      },
    );
  });

  bot.action("steps:add", async (ctx) => {
    if (!ctx.chat) return ctx.answerCbQuery();
    if (!allowed(ctx.chat.id)) return ctx.answerCbQuery("Not allowed.");
    const chatId = ctx.chat.id;
    const session = getSession(chatId);
    if (session.phase !== "draft") {
      await ctx.answerCbQuery("This listing is no longer active.");
      return;
    }
    if (session.draft.steps.length >= MAX_STEPS) {
      await ctx.answerCbQuery(`Maximum ${MAX_STEPS} steps reached.`);
      return;
    }
    setSession(chatId, { phase: "edit_step_add", draft: session.draft });
    await ctx.answerCbQuery();
    return ctx.editMessageText("Send the new step:", {
      parse_mode: "Markdown",
      ...cancelOnlyKeyboard(),
    });
  });

  bot.action("steps:remove", async (ctx) => {
    if (!ctx.chat) return ctx.answerCbQuery();
    if (!allowed(ctx.chat.id)) return ctx.answerCbQuery("Not allowed.");
    const chatId = ctx.chat.id;
    const session = getSession(chatId);
    if (session.phase !== "draft" || session.draft.steps.length === 0) {
      await ctx.answerCbQuery("No steps to remove.");
      return;
    }
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      `*Steps*\n\n${renderStepsList(session.draft.steps)}\n\nPick a step to remove:`,
      {
        parse_mode: "Markdown",
        ...stepsRemoveKeyboard(session.draft.steps.length),
      },
    );
  });

  bot.action("edit:steps", async (ctx) => {
    if (!ctx.chat) return ctx.answerCbQuery();
    if (!allowed(ctx.chat.id)) return ctx.answerCbQuery("Not allowed.");
    const chatId = ctx.chat.id;
    const session = getSession(chatId);
    if (session.phase !== "draft") {
      await ctx.answerCbQuery("This listing is no longer active.");
      return;
    }
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      `*Steps*\n\n${renderStepsList(session.draft.steps)}\n\nChoose what to do:`,
      {
        parse_mode: "Markdown",
        ...stepsMenuKeyboard(session.draft.steps.length),
      },
    );
  });

  bot.action("edit:task", async (ctx) => {
    if (!ctx.chat) return ctx.answerCbQuery();
    if (!allowed(ctx.chat.id)) return ctx.answerCbQuery("Not allowed.");
    const chatId = ctx.chat.id;
    const session = getSession(chatId);
    if (session.phase !== "draft") {
      await ctx.answerCbQuery("This listing is no longer active.");
      return;
    }
    setSession(chatId, { phase: "edit_task", draft: session.draft });
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      "Send the new task (what the participant must do, at most 2 lines):",
      {
        parse_mode: "Markdown",
        ...cancelOnlyKeyboard(),
      },
    );
  });

  bot.action("edit:details", async (ctx) => {
    if (!ctx.chat) return ctx.answerCbQuery();
    if (!allowed(ctx.chat.id)) return ctx.answerCbQuery("Not allowed.");
    const chatId = ctx.chat.id;
    const session = getSession(chatId);
    if (session.phase !== "draft") {
      await ctx.answerCbQuery("This listing is no longer active.");
      return;
    }
    setSession(chatId, { phase: "edit_details", draft: session.draft });
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      `Send the new campaign details (at most ${MAX_DETAILS_WORDS} words):`,
      {
        parse_mode: "Markdown",
        ...cancelOnlyKeyboard(),
      },
    );
  });

  bot.action("edit", async (ctx) => {
    if (!ctx.chat) return ctx.answerCbQuery();
    if (!allowed(ctx.chat.id)) return ctx.answerCbQuery("Not allowed.");
    const chatId = ctx.chat.id;
    const session = getSession(chatId);
    if (session.phase !== "draft") {
      await ctx.answerCbQuery("This listing is no longer active.");
      return;
    }
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      "What would you like to edit?",
      { ...editMenuKeyboard() },
    );
  });

  bot.action("list", async (ctx) => {
    if (!ctx.chat) return ctx.answerCbQuery();
    if (!allowed(ctx.chat.id)) return ctx.answerCbQuery("Not allowed.");
    const chatId = ctx.chat.id;
    const session = getSession(chatId);
    if (session.phase !== "draft") {
      await ctx.answerCbQuery("This listing is no longer active.");
      return;
    }
    setSession(chatId, { phase: "awaiting_handle", draft: session.draft });
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      "Send the project's X/Twitter handle (e.g. @ProjectName):",
      {
        parse_mode: "Markdown",
        ...cancelOnlyKeyboard(),
      },
    );
  });

  bot.action("confirm:list", async (ctx) => {
    if (!ctx.chat) return ctx.answerCbQuery();
    if (!allowed(ctx.chat.id)) return ctx.answerCbQuery("Not allowed.");
    const chatId = ctx.chat.id;
    const session = getSession(chatId);
    if (session.phase !== "confirm") {
      await ctx.answerCbQuery("This listing is no longer active.");
      return;
    }

    const handle = session.profile.screen_name || "";
    const profile = session.profile;
    const draft = session.draft;

    await ctx.answerCbQuery();
    await ctx.replyWithChatAction("typing");

    const result = await listProjectViaTelegram({
      handle,
      name: draft.project_name,
      avatar: profile.avatar,
      banner: profile.banner,
      bio: profile.bio,
      followers: profile.followers,
      following: profile.following,
      verified: profile.verified,
      joined: profile.joined,
      task: draft.task,
      details: draft.details,
      steps: draft.steps,
      prize_pool: draft.prize_pool,
      campaign_url: draft.campaign_url,
    });

    if (result.ok) {
      clearSession(chatId);
      return ctx.reply(
        `✅ *Listed successfully.*\n\n` +
          `${esc(draft.project_name)} (@${handle}) is now live on the site.`,
        { parse_mode: "Markdown" },
      );
    }

    if (result.duplicate) {
      clearSession(chatId);
      return ctx.reply(
        `⚠️ ${result.error} - it was already stored, so it is already on the site.`,
      );
    }

    // Storage failure - stay in confirm so the user can retry or cancel.
    console.error("[telegram-bot] listing failed:", result.error);
    return ctx.reply(
      `⚠️ Could not list the project: ${result.error}\n\n` +
        `Press List to retry, or Cancel.`,
      confirmKeyboard(),
    );
  });

  bot.action("skip:link", async (ctx) => {
    if (!ctx.chat) return ctx.answerCbQuery();
    if (!allowed(ctx.chat.id)) return ctx.answerCbQuery("Not allowed.");
    const chatId = ctx.chat.id;
    const session = getSession(chatId);
    if (session.phase !== "awaiting_link") {
      await ctx.answerCbQuery("This listing is no longer active.");
      return;
    }
    await ctx.answerCbQuery("Skipped.");
    // campaign_url stays "" - the preview just omits the link line.
    setSession(chatId, {
      phase: "confirm",
      draft: session.draft,
      profile: session.profile,
    });
    return showConfirm(ctx, session.draft, session.profile);
  });

  bot.action("noop", async (ctx) => ctx.answerCbQuery());

  bot.action("cancel", async (ctx) => {
    if (!ctx.chat) return ctx.answerCbQuery();
    if (!allowed(ctx.chat.id)) return ctx.answerCbQuery("Not allowed.");
    const chatId = ctx.chat.id;
    clearSession(chatId);
    await ctx.answerCbQuery("Cancelled.");
    return ctx
      .editMessageText("Cancelled. Send a new link to start another listing.")
      .catch(() => ctx.reply("Cancelled. Send a new link to start another listing."));
  });

  bot.catch((error) => {
    console.error("[telegram-bot] unhandled error:", error);
  });

  console.log("Telegram bot started - waiting for messages (Ctrl+C to stop)");
  await bot.launch();
}

main().catch((error) => {
  console.error("[telegram-bot] fatal:", error);
  process.exit(1);
});
