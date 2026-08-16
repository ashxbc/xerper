import { isSupabaseConfigured, serverClient } from "./supabase";

export { isSupabaseConfigured };

/**
 * Supabase persistence for projects listed through the Telegram bot.
 *
 * These are NOT NFT-scan results - they are manually curated campaign
 * listings (project name, task, campaign details, steps) confirmed by a user
 * in Telegram. They live in their own `projects` table, entirely separate
 * from the discovery scan's `nft_projects`, and are published to the site the
 * moment the insert succeeds (status 'listed').
 */

/** Complete campaign data for a project listed through the Telegram bot. */
export type TelegramListing = {
  handle: string;
  name: string;
  avatar: string;
  banner: string;
  bio: string;
  followers: number;
  following: number;
  verified: boolean;
  joined: string;
  task: string;
  details: string;
  steps: string[];
  prize_pool: string;
  campaign_url: string;
};

export type ListProjectResult =
  | { ok: true; handle: string }
  | { ok: false; error: string; duplicate?: boolean };

/** Insert a bot-listed project into the projects table with status 'listed'
 *  so it is immediately published to the site. The lowercased X handle is the
 *  dedup key: a handle already in the table - whatever its status - is a
 *  duplicate and is never inserted again. */
export async function listProjectViaTelegram(
  listing: TelegramListing,
): Promise<ListProjectResult> {
  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      error:
        "Supabase is not configured - set NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY so the listing can be stored",
    };
  }

  const handle = listing.handle.trim().toLowerCase();
  if (!handle) {
    return { ok: false, error: "The X handle is required" };
  }
  if (!listing.name.trim()) {
    return { ok: false, error: "The project name is required" };
  }
  if (!listing.task.trim()) {
    return { ok: false, error: "The task is required" };
  }
  if (!listing.details.trim()) {
    return { ok: false, error: "Campaign details are required" };
  }
  if (!Array.isArray(listing.steps) || listing.steps.length === 0) {
    return { ok: false, error: "At least one step is required" };
  }
  if (listing.steps.length > 6) {
    return { ok: false, error: "No more than 6 steps are allowed" };
  }
  if (listing.campaign_url && !/^https?:\/\//.test(listing.campaign_url)) {
    return { ok: false, error: "The campaign link must be a valid http(s) URL" };
  }

  const db = serverClient();

  // Dedup against everything already stored.
  const { data: existing, error: fetchError } = await db
    .from("projects")
    .select("handle")
    .eq("handle", handle)
    .maybeSingle();
  if (fetchError) {
    return { ok: false, error: `Failed to check existing projects: ${fetchError.message}` };
  }
  if (existing) {
    return { ok: false, duplicate: true, error: "This project is already listed" };
  }

  const now = new Date().toISOString();
  const { error: insertError } = await db.from("projects").insert({
    handle,
    name: listing.name.trim(),
    avatar: listing.avatar,
    banner: listing.banner,
    bio: listing.bio,
    followers: listing.followers,
    following: listing.following,
    verified: listing.verified,
    joined: listing.joined,
    task: listing.task.trim(),
    details: listing.details.trim(),
    steps: listing.steps,
    prize_pool: listing.prize_pool.trim(),
    campaign_url: listing.campaign_url.trim(),
    source: "telegram",
    status: "listed",
    listed_at: now,
    updated_at: now,
  });
  if (insertError) {
    return { ok: false, error: `Failed to store the listing: ${insertError.message}` };
  }

  return { ok: true, handle };
}

/** Shape served to the website for a bot-listed project. */
export type ListedProject = {
  handle: string;
  name: string;
  avatar: string;
  banner: string;
  bio: string;
  followers: number;
  following: number;
  verified: boolean;
  joined: string;
  task: string;
  details: string;
  steps: string[];
  prize_pool: string;
  campaign_url: string;
};

/** Projects currently published to the site, newest listing first. */
export async function listProjects(): Promise<ListedProject[]> {
  if (!isSupabaseConfigured()) return [];

  const { data, error } = await serverClient()
    .from("projects")
    .select("*")
    .eq("status", "listed")
    .order("listed_at", { ascending: false })
    .limit(100);

  // The projects table is created by supabase/schema.sql. Until that
  // migration has been run the table may not exist (42P01) or may be missing
  // the newest columns (42703) - treat both as "no projects yet" rather than
  // a hard failure, the same way the rest of the app degrades gracefully
  // before Supabase is set up.
  if (error) {
    if (error.code === "42P01" || error.code === "42703") return [];
    throw error;
  }

  return (data ?? []).map((row) => ({
    handle: String(row.handle),
    name: String(row.name ?? ""),
    avatar: String(row.avatar ?? ""),
    banner: String(row.banner ?? ""),
    bio: String(row.bio ?? ""),
    followers: Number(row.followers ?? 0),
    following: Number(row.following ?? 0),
    verified: Boolean(row.verified ?? false),
    joined: String(row.joined ?? ""),
    task: String(row.task ?? ""),
    details: String(row.details ?? ""),
    steps: Array.isArray(row.steps) ? row.steps.map(String) : [],
    prize_pool: String(row.prize_pool ?? ""),
    campaign_url: String(row.campaign_url ?? ""),
  }));
}
