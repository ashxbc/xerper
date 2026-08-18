import { isSupabaseConfigured, serverClient } from "../supabase";

// Keep only ~5 weeks of post rows per handle so storage stays small while
// still covering the 4 weekly periods the chart needs plus buffer.
const RETAIN_DAYS = 35;

export type DailySnapshot = {
  tweet_date: string; // YYYY-MM-DD
  tweet_count: number;
  reply_count: number;
  total_impressions: number;
  // When this day's row was last refreshed from X (null on fresh runs).
  fetched_at?: string;
};

export type PostRow = {
  tweet_id: string;
  tweet_date: string; // YYYY-MM-DD
  post_type: "post" | "reply";
  impressions: number;
  likes: number;
  replies: number;
  reposts: number;
};

export type StoredProfile = {
  handle: string;
  name: string;
  avatar: string;
  followers: number;
  verified: boolean;
  last_fetched_at: string;
};

/** Date N days before today, as YYYY-MM-DD (UTC-safe). */
function daysAgoStr(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Fetch stored daily impression rows for a handle, newest-first, bounded to
 *  the retention window (the chart only ever shows 4 weeks). */
export async function fetchDailyImpressions(
  handle: string,
): Promise<DailySnapshot[]> {
  if (!isSupabaseConfigured()) return [];

  try {
    const client = serverClient();
    const { data, error } = await client
      .from("x_analytics_daily")
      .select("tweet_date, tweet_count, reply_count, total_impressions, fetched_at")
      .eq("handle", handle.toLowerCase())
      .gte("tweet_date", daysAgoStr(RETAIN_DAYS))
      .order("tweet_date", { ascending: false });

    if (error) {
      console.error("[analytics-store] fetchDailyImpressions:", error.message);
      return [];
    }
    // PostgREST can return bigint columns as strings depending on the
    // project/client configuration. Normalize them at the API boundary so
    // the frontend can safely aggregate weekly and monthly totals with `+`.
    const rows: Array<DailySnapshot | null> = (data ?? []).map((row) => {
        const value = row as Record<string, unknown>;
        const tweetDate = String(value.tweet_date ?? "").slice(0, 10);
        const tweetCount = Number(value.tweet_count ?? 0);
        const replyCount = Number(value.reply_count ?? 0);
        const totalImpressions = Number(value.total_impressions ?? 0);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(tweetDate)) return null;
        return {
          tweet_date: tweetDate,
          tweet_count: Number.isFinite(tweetCount) ? Math.max(0, tweetCount) : 0,
          reply_count: Number.isFinite(replyCount) ? Math.max(0, replyCount) : 0,
          total_impressions: Number.isFinite(totalImpressions)
            ? Math.max(0, totalImpressions)
            : 0,
          fetched_at: value.fetched_at == null ? undefined : String(value.fetched_at),
        };
      });
    return rows.filter((row): row is DailySnapshot => row !== null);
  } catch {
    return [];
  }
}

/** Fetch stored post-level rows for a handle within the retention window.
 *  Used by the stats modal, which needs per-post interaction counts that the
 *  daily projection table does not carry. Newest-first. */
export async function fetchPostRows(
  handle: string,
): Promise<PostRow[]> {
  if (!isSupabaseConfigured()) return [];

  try {
    const client = serverClient();
    const { data, error } = await client
      .from("x_analytics_posts")
      .select("tweet_id, tweet_date, post_type, impressions, likes, replies, reposts")
      .eq("handle", handle.toLowerCase())
      .gte("tweet_date", daysAgoStr(RETAIN_DAYS))
      .order("tweet_date", { ascending: false });

    if (error) {
      console.error("[analytics-store] fetchPostRows:", error.message);
      return [];
    }

    return (data ?? []).map((row) => {
      const value = row as Record<string, unknown>;
      const num = (v: unknown): number => {
        const n = Number(v ?? 0);
        return Number.isFinite(n) ? Math.max(0, n) : 0;
      };
      const pt = String(value.post_type ?? "post");
      return {
        tweet_id: String(value.tweet_id ?? ""),
        tweet_date: String(value.tweet_date ?? "").slice(0, 10),
        post_type: pt === "reply" ? "reply" : "post",
        impressions: num(value.impressions),
        likes: num(value.likes),
        replies: num(value.replies),
        reposts: num(value.reposts),
      };
    });
  } catch {
    return [];
  }
}

/** Upsert post-level impression rows. Each row is keyed by (handle, tweet_id)
 *  so re-fetching a tweet updates its count instead of duplicating it. */
export async function upsertPosts(
  handle: string,
  posts: PostRow[],
): Promise<void> {
  if (!isSupabaseConfigured() || posts.length === 0) return;

  try {
    const client = serverClient();
    const { error } = await client.from("x_analytics_posts").upsert(
      posts.map((p) => ({
        handle: handle.toLowerCase(),
        tweet_id: p.tweet_id,
        tweet_date: p.tweet_date,
        post_type: p.post_type,
        impressions: p.impressions,
        likes: p.likes,
        replies: p.replies,
        reposts: p.reposts,
        fetched_at: new Date().toISOString(),
      })),
      { onConflict: "handle,tweet_id" },
    );

    if (error) {
      console.error("[analytics-store] upsertPosts:", error.message);
    }
  } catch (err) {
    console.error("[analytics-store] upsertPosts:", err);
  }
}

/** Rebuild the per-day totals for a handle straight from its stored post
 *  rows, then prune anything outside the retention window. This keeps the
 *  daily table an exact projection of the post-level source of truth. */
export async function recomputeDaily(handle: string): Promise<void> {
  if (!isSupabaseConfigured()) return;

  try {
    const client = serverClient();
    const since = daysAgoStr(RETAIN_DAYS);

    const { data, error } = await client
      .from("x_analytics_posts")
      .select("tweet_date, post_type, impressions")
      .eq("handle", handle.toLowerCase())
      .gte("tweet_date", since);

    if (error) {
      console.error("[analytics-store] recomputeDaily:", error.message);
      return;
    }

    // Aggregate per day, then replace that handle's daily rows wholesale -
    // simpler and always consistent with the posts table.
    const byDay = new Map<string, { count: number; replies: number; total: number }>();
    for (const row of data ?? []) {
      const r = row as { tweet_date: string; impressions: number; post_type: string };
      const existing = byDay.get(r.tweet_date) ?? { count: 0, replies: 0, total: 0 };
      if (r.post_type === "reply") {
        existing.replies += 1;
      } else {
        existing.count += 1;
      }
      existing.total += r.impressions;
      byDay.set(r.tweet_date, existing);
    }

    const rows = [...byDay.entries()]
      .map(([tweet_date, agg]) => ({
        handle: handle.toLowerCase(),
        tweet_date,
        tweet_count: agg.count,
        reply_count: agg.replies,
        total_impressions: agg.total,
        fetched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }))
      .sort((a, b) => b.tweet_date.localeCompare(a.tweet_date));

    // Delete + re-insert is the cleanest "rebuild" - the handle's window is
    // small (<=35 rows), and it can never leave stale days behind.
    await client
      .from("x_analytics_daily")
      .delete()
      .eq("handle", handle.toLowerCase());

    if (rows.length > 0) {
      const { error: insertError } = await client
        .from("x_analytics_daily")
        .insert(rows);
      if (insertError) {
        console.error("[analytics-store] recomputeDaily insert:", insertError.message);
      }
    }
  } catch (err) {
    console.error("[analytics-store] recomputeDaily:", err);
  }
}

/** Store or update the profile snapshot for a handle. */
export async function upsertProfile(profile: StoredProfile): Promise<void> {
  if (!isSupabaseConfigured()) return;

  try {
    const client = serverClient();
    const { error } = await client.from("x_analytics_profiles").upsert(
      {
        handle: profile.handle.toLowerCase(),
        name: profile.name,
        avatar: profile.avatar,
        followers: profile.followers,
        verified: profile.verified,
        last_fetched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "handle" },
    );

    if (error) {
      console.error("[analytics-store] upsertProfile:", error.message);
    }
  } catch (err) {
    console.error("[analytics-store] upsertProfile:", err);
  }
}

/** Delete stored post + daily rows older than the retention window. */
export async function pruneOldData(
  handle: string,
  olderThanDays = RETAIN_DAYS,
): Promise<void> {
  if (!isSupabaseConfigured()) return;

  try {
    const cutoff = daysAgoStr(olderThanDays);
    const client = serverClient();
    await client
      .from("x_analytics_posts")
      .delete()
      .eq("handle", handle.toLowerCase())
      .lt("tweet_date", cutoff);
    await client
      .from("x_analytics_daily")
      .delete()
      .eq("handle", handle.toLowerCase())
      .lt("tweet_date", cutoff);
  } catch (err) {
    console.error("[analytics-store] pruneOldData:", err);
  }
}
