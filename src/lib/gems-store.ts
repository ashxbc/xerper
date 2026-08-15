import { isSupabaseConfigured, serverClient } from "./supabase";
import type { DiscoveryResult, DiscoveryVerdict } from "./x/discovery";

export { isSupabaseConfigured };

/**
 * Supabase persistence for the NFT-discovery pipeline.
 *
 * Two tables:
 *   - nft_projects  - one row per discovered handle (the dedup key is the
 *                     lowercased handle, enforced by a unique index). TRUE
 *                     verdicts are stored as status 'added' (immediately
 *                     published to the site), FALSE verdicts as 'rejected'.
 *                     Any handle that already exists - whatever its status -
 *                     is a duplicate and is skipped on later runs.
 *   - gems_scan_logs - one row per Gems Finding API call, logged in two
 *                     phases: a 'running' row is inserted the moment the
 *                     endpoint is invoked (so even a scan killed mid-run
 *                     leaves a trace), then finalized to 'success'/'partial'/
 *                     'failed' with the run's counts when it finishes.
 *
 * Every function here is a no-op (or throws when the caller forces an actual
 * DB write) when Supabase is not configured, so the app still runs before the
 * env vars are set.
 */

export type PersistenceStats = {
  configured: boolean;
  projects_new: number;
  projects_skipped_duplicates: number;
  log_inserted: boolean;
  error?: string;
};

/** Shape served to the website (matches the XProfileCard props). */
export type GemProfile = {
  handle: string;
  name: string;
  avatar: string;
  banner: string;
  bio: string;
  followers: number;
  following: number;
  verified: boolean;
  joined: string;
};

type ProjectRow = {
  handle: string;
  name: string;
  avatar: string;
  banner: string;
  bio: string;
  followers: number;
  following: number;
  verified: boolean;
  joined: string;
  recent_tweet: string;
  is_nft_project: boolean;
  source_query: string;
  seen_in_post_url: string;
  status: "added" | "rejected";
  processed: boolean;
  discovered_at: string;
  added_at: string | null;
  processed_at: string | null;
};

function verdictToRow(verdict: DiscoveryVerdict, now: string): ProjectRow {
  const accepted = verdict.is_nft_project;
  return {
    // Lowercased so the unique handle index is the dedup key regardless of
    // how X happens to capitalise the account in different responses.
    handle: verdict.handle.toLowerCase(),
    name: verdict.name,
    avatar: verdict.avatar,
    banner: verdict.banner,
    bio: verdict.bio,
    followers: verdict.followers,
    following: verdict.following,
    verified: verdict.verified,
    joined: verdict.joined,
    recent_tweet: verdict.recent_tweet,
    is_nft_project: accepted,
    source_query: verdict.source_query,
    seen_in_post_url: verdict.seen_in_post_url,
    status: accepted ? "added" : "rejected",
    processed: accepted,
    discovered_at: now,
    added_at: accepted ? now : null,
    processed_at: accepted ? now : null,
  };
}

/** Final fields written to a scan-log row once a run finishes. */
export type ScanLogFinal = {
  finished_at: string;
  status: "success" | "partial" | "failed";
  projects_found: number;
  projects_new: number;
  projects_skipped_duplicates: number;
  projects_rejected: number;
  candidates_considered: number;
  queries_run: number;
  posts_scanned: number;
  rate_limited: boolean;
  error?: string;
};

/** Persist a completed scan: insert new handles, skip existing ones, and
 *  finalize the run's scan-log row. Returns the new/skipped counts and any
 *  storage error. Storage failures are recorded on the log row rather than
 *  thrown, so a half-written run is still fully visible in the log table. */
export async function persistScanRun(
  result: DiscoveryResult,
  logId?: number,
): Promise<PersistenceStats> {
  const stats: PersistenceStats = {
    configured: false,
    projects_new: 0,
    projects_skipped_duplicates: 0,
    log_inserted: false,
  };
  if (!isSupabaseConfigured()) return stats;
  stats.configured = true;

  const db = serverClient();
  const now = new Date().toISOString();

  const verdicts = [...result.projects, ...result.rejected];
  const lowerHandles = verdicts.map((v) => v.handle.toLowerCase());

  // Everything already in the table counts as a duplicate, even if it was
  // previously rejected - a handle is judged once and never re-added.
  const { data: existing, error: fetchError } = await db
    .from("nft_projects")
    .select("handle")
    .in("handle", lowerHandles);
  if (fetchError) {
    stats.error = `failed to read existing projects: ${fetchError.message}`;
  } else {
    const known = new Set(
      (existing ?? []).map((row) => String(row.handle).toLowerCase()),
    );
    const fresh = verdicts.filter((v) => !known.has(v.handle.toLowerCase()));
    stats.projects_skipped_duplicates = verdicts.length - fresh.length;

    if (fresh.length > 0) {
      const rows = fresh.map((v) => verdictToRow(v, now));
      const { error: insertError } = await db.from("nft_projects").insert(rows);
      if (insertError) {
        stats.error = `failed to store projects: ${insertError.message}`;
      } else {
        stats.projects_new = fresh.filter((v) => v.is_nft_project).length;
      }
    }
  }

  // Finalize the run's log row (or create one when the caller didn't open
  // one). Kept separate from the project insert above, so even a storage
  // failure still leaves a complete record of the run.
  const final: ScanLogFinal = {
    finished_at: now,
    status: result.rate_limited || stats.error ? "partial" : "success",
    projects_found: result.projects.length,
    projects_new: stats.projects_new,
    projects_skipped_duplicates: stats.projects_skipped_duplicates,
    projects_rejected: result.rejected.length,
    candidates_considered: result.candidates_considered,
    queries_run: result.queries_run,
    posts_scanned: result.posts_scanned,
    rate_limited: result.rate_limited,
    error: stats.error,
  };

  const finalize = logId
    ? db.from("gems_scan_logs").update(final).eq("id", logId)
    : db.from("gems_scan_logs").insert({ started_at: result.generated_at, ...final });
  const { error: logError } = await finalize;
  if (logError) {
    stats.error = `failed to write scan log: ${logError.message}`;
  } else {
    stats.log_inserted = true;
  }

  return stats;
}

/** Open a scan-log row ('running') when a Gems Finding API call arrives, or
 *  record a standalone failure. Returns the row's id for 'running' rows so
 *  the caller can finalize it later - every invocation, even one killed
 *  mid-scan, leaves a trace in the log table. */
export async function insertScanLog(entry: {
  status: "running" | "failed";
  error?: string;
}): Promise<number | null> {
  if (!isSupabaseConfigured()) return null;
  const { data, error } = await serverClient()
    .from("gems_scan_logs")
    .insert({
      started_at: new Date().toISOString(),
      status: entry.status,
      projects_found: 0,
      projects_new: 0,
      projects_skipped_duplicates: 0,
      projects_rejected: 0,
      candidates_considered: 0,
      queries_run: 0,
      posts_scanned: 0,
      rate_limited: false,
      error: entry.error?.slice(0, 2000),
    })
    .select("id")
    .single();
  if (error) throw error;
  return data?.id ?? null;
}

/** Finalize a 'running' scan-log row after the scan completes. */
export async function updateScanLog(
  id: number,
  patch: ScanLogFinal,
): Promise<void> {
  if (!isSupabaseConfigured()) return;
  await serverClient().from("gems_scan_logs").update(patch).eq("id", id);
}

/** Projects currently published to the site, lowest follower count first -
 *  the "still pre-hype" signal the whole scan is built around. */
export async function listAddedProjects(): Promise<GemProfile[]> {
  if (!isSupabaseConfigured()) return [];

  const { data, error } = await serverClient()
    .from("nft_projects")
    .select("*")
    .eq("status", "added")
    .order("followers", { ascending: true })
    .limit(100);

  if (error) throw error;

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
  }));
}
