/** Minimal Groq chat-completions client. Two narrow jobs:
 *  - classify whether an X handle represents a crypto NFT project
 *  - extract project name / details / prize pool from pasted text (Telegram bot)
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";

/** Groq key for a given workload. The Telegram bot can use its own separate
 *  account (TELEGRAM_GROQ_API_KEY) and falls back to the shared GROQ_API_KEY
 *  so the two workloads can run on different accounts if desired. */
function groqApiKey(): string {
  return (
    (process.env.TELEGRAM_GROQ_API_KEY ?? "").trim() ||
    (process.env.GROQ_API_KEY ?? "").trim()
  );
}

export type ClassificationInput = {
  handle: string;
  bio: string;
  recentTweet: string;
};

const SYSTEM_PROMPT =
  "You classify X (Twitter) accounts for PRE-MINT NFT discovery. Return true " +
  "only when the HANDLE'S OWN ACCOUNT is a crypto NFT project whose mint has " +
  "definitely NOT started yet and is clearly upcoming, pre-mint, or launching " +
  "soon. Return false if minting is live, open, started, completed, minted out, " +
  "sold out, trading, or already available on OpenSea. Return false if timing " +
  "is unclear. A person promoting or mentioning a project is also false. Judge " +
  "the account, not isolated NFT keywords. Reply with exactly one word: true " +
  "or false. No punctuation, explanation, or other text.";

function buildUserPrompt({ handle, bio, recentTweet }: ClassificationInput): string {
  return [
    `Handle: @${handle}`,
    `Bio: ${bio || "(empty)"}`,
    `Most recent tweet: ${recentTweet || "(none)"}`,
    "",
    "Is this the project's own account AND is its mint clearly still upcoming and not started? Answer true or false only.",
  ].join("\n");
}

/** Returns true/false, or throws if Groq is unreachable, misconfigured, or
 *  answers with anything other than a clean true/false - callers should
 *  treat a thrown error as "skip this candidate", not as a false verdict. */
export async function classifyNftProject(
  input: ClassificationInput,
): Promise<boolean> {
  const apiKey = groqApiKey();
  if (!apiKey) {
    throw new Error("No Groq session configured - set GROQ_API_KEY");
  }

  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0,
      max_tokens: 5,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(input) },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Groq returned ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = (data.choices?.[0]?.message?.content ?? "").trim().toLowerCase();

  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Groq returned an unexpected answer: "${raw}"`);
}

// ---- project extraction (Telegram bot) -------------------------------------

export type ProjectExtraction = {
  project_name: string;
  details: string;
  prize_pool: string;
};

const EXTRACT_SYSTEM_PROMPT =
  "You extract information about a project, campaign, bounty, hackathon, or " +
  "airdrop from pasted text. Answer with ONLY a JSON object, no markdown, no " +
  "extra text: " +
  '{"project_name": "the project/company name", ' +
  '"details": "2-3 sentence plain summary of what the project is and what the campaign involves", ' +
  '"prize_pool": "the total prize pool / reward amount, or \"Not stated\" if the text does not mention any prize"}';

function buildExtractUserPrompt(text: string): string {
  return [
    "Extract the project name, details, and prize pool from the following text. " +
      "If the text contains no clear project, set project_name to \"Unknown\". " +
      "If it contains no prize information, set prize_pool to \"Not stated\".",
    "",
    text.slice(0, 12_000),
    "",
    "Answer with the JSON object only.",
  ].join("\n");
}

/** Extract project name, details, and prize pool from arbitrary pasted text
 *  (tweet text, a website page, a listing description, ...). Throws on
 *  transport/parse errors so callers can report the failure instead of
 *  trusting a malformed verdict. */
export async function extractProjectFromText(
  text: string,
): Promise<ProjectExtraction> {
  const apiKey = groqApiKey();
  if (!apiKey) {
    throw new Error(
      "No Groq session configured - set GROQ_API_KEY (or TELEGRAM_GROQ_API_KEY)",
    );
  }
  if (!text.trim()) {
    throw new Error("No text to extract from");
  }

  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0,
      max_tokens: 400,
      messages: [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT },
        { role: "user", content: buildExtractUserPrompt(text) },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Groq returned ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = (data.choices?.[0]?.message?.content ?? "").trim();

  // The model sometimes wraps JSON in ```json fences - strip them.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = (fenced ? fenced[1] : raw).trim();
  const obj = JSON.parse(jsonText) as Record<string, unknown>;

  return {
    project_name: String(obj.project_name ?? "Unknown").trim() || "Unknown",
    details: String(obj.details ?? "").trim(),
    prize_pool: String(obj.prize_pool ?? "Not stated").trim() || "Not stated",
  };
}

// ---- Telegram listing extraction -------------------------------------------
// The listing workflow (scripts/telegram-bot.ts) turns a submitted
// project/tweet link into the data the site renders: project name, a short
// actionable task, concise campaign details (max 50 words), and up to 6
// steps. The Groq answer is post-processed here so the limits are enforced
// even if the model drifts.

export type ListingExtraction = {
  project_name: string;
  task: string;
  details: string;
  steps: string[];
  prize_pool: string;
};

const LISTING_SYSTEM_PROMPT =
  "You turn a project announcement into a structured campaign listing. " +
  "Answer with ONLY a JSON object, no markdown, no extra text: " +
  '{"project_name": "the actual project name", ' +
  '"task": "a very short, actionable 2-line task describing what the campaign participant needs to DO - e.g. Make a short video about XYZ and explain what makes the project interesting. Never copy the project\'s own marketing/product description", ' +
  '"details": "concise campaign details in at most 50 words, focused on the campaign itself", ' +
  '"steps": ["up to 6 clear, actionable, concise steps"], ' +
  '"prize_pool": "the campaign prize/reward, e.g. $5,000 USDC, or \"Not stated\" if the text does not mention a prize"}';

function buildListingUserPrompt(text: string): string {
  return [
    "Extract the project listing from the following text. Rules:",
    "- project_name: the actual project name (Unknown if the text has no clear project)",
    "- task: what the participant must DO, in at most 2 lines - an action, not a description",
    "- details: at most 50 words, concise and about the campaign",
    "- steps: 1 to 6 steps, each short and actionable",
    "- prize_pool: the prize/reward amount if the text mentions one, otherwise Not stated",
    "",
    text.slice(0, 12_000),
    "",
    "Answer with the JSON object only.",
  ].join("\n");
}

/** Enforce the listing limits regardless of what the model returns: steps
 *  become a clean 1-6 item array, details are cut to 50 words, and the task
 *  is capped at two lines. */
function normalizeListing(raw: Record<string, unknown>): ListingExtraction {
  const name = String(raw.project_name ?? "Unknown").trim() || "Unknown";

  const task = String(raw.task ?? "").trim().replace(/\s+/g, " ");

  const details = String(raw.details ?? "").trim().replace(/\s+/g, " ");
  const detailsWords = details.split(/\s+/).filter(Boolean);
  const cappedDetails = detailsWords.slice(0, 50).join(" ");

  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  const steps = rawSteps
    .map((step) => String(step ?? "").trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .slice(0, 6);

  const prizePool = String(raw.prize_pool ?? "").trim() || "Not stated";

  return {
    project_name: name,
    task,
    details: cappedDetails,
    steps,
    prize_pool: prizePool,
  };
}

/** Extract a full campaign listing (name, task, details, steps) from
 *  arbitrary pasted text - the tweet/thread/URL content submitted through
 *  the Telegram bot. Throws on transport/parse errors so the bot can report
 *  the failure instead of trusting a malformed extraction. */
export async function extractListingFromText(
  text: string,
): Promise<ListingExtraction> {
  const apiKey = groqApiKey();
  if (!apiKey) {
    throw new Error(
      "No Groq session configured - set GROQ_API_KEY (or TELEGRAM_GROQ_API_KEY)",
    );
  }
  if (!text.trim()) {
    throw new Error("No text to extract from");
  }

  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0,
      max_tokens: 600,
      messages: [
        { role: "system", content: LISTING_SYSTEM_PROMPT },
        { role: "user", content: buildListingUserPrompt(text) },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Groq returned ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = (data.choices?.[0]?.message?.content ?? "").trim();

  // The model sometimes wraps JSON in ```json fences - strip them.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = (fenced ? fenced[1] : raw).trim();
  const obj = JSON.parse(jsonText) as Record<string, unknown>;

  return normalizeListing(obj);
}

