import { NextResponse } from "next/server";
import {
  acquireAnalyticsAccount,
  reportAnalyticsRateLimited,
} from "@/lib/x/accounts";
import { discover } from "@/lib/x/endpoints";
import { XSearch, EndpointMoved, RateLimited, AuthFailed } from "@/lib/x/search";
import {
  fetchDailyImpressions,
  fetchPostRows,
  upsertPosts,
  recomputeDaily,
  pruneOldData,
  upsertProfile,
  type PostRow,
} from "@/lib/x/analytics-store";
import { isSupabaseConfigured, serverClient } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// If today's data was already fetched within this window, serve it straight
// from Supabase without touching X at all.
const FRESH_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Build a search query for all original tweets by a user (excludes
 *  retweets AND replies, so this only returns standalone posts). Replies
 *  are fetched separately via buildRepliesQuery. */
function buildTimelineQuery(handle: string, since: string | null): string {
  const base = `from:${handle} -filter:retweets -filter:replies`;
  return since ? `${base} since:${since}` : base;
}

/** Build a search query for reply tweets by a user. */
function buildRepliesQuery(handle: string, since: string | null): string {
  const base = `from:${handle} filter:replies`;
  return since ? `${base} since:${since}` : base;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Aggregated engagement stats for a single period. */
export type PeriodStats = {
  impressions: number;
  engagements: number;
  likes: number;
  replies: number;
  reposts: number;
  engagement_rate: number; // percent, 0 when there are no impressions
};

/** Sum interaction counts over posts whose tweet_date falls inside the
 *  [startDate, today] window (inclusive). Engagements = likes + replies +
 *  reposts on the user's own posts; rate = engagements / impressions. */
function computeStats(posts: PostRow[], startDate: string): PeriodStats {
  let impressions = 0;
  let likes = 0;
  let replies = 0;
  let reposts = 0;
  for (const p of posts) {
    if (p.tweet_date < startDate) continue;
    impressions += p.impressions;
    likes += p.likes;
    replies += p.replies;
    reposts += p.reposts;
  }
  const engagements = likes + replies + reposts;
  return {
    impressions,
    engagements,
    likes,
    replies,
    reposts,
    engagement_rate:
      impressions > 0 ? (engagements / impressions) * 100 : 0,
  };
}

/** Weekly = past 7 calendar days, monthly = past 28 days (4 weekly periods).
 *  Both end today, matching the chart's windows. */
function computeAllStats(posts: PostRow[]): {
  weekly: PeriodStats;
  monthly: PeriodStats;
} {
  return {
    weekly: computeStats(posts, daysAgoStr(6)),
    monthly: computeStats(posts, daysAgoStr(27)),
  };
}

/** A date N days before today, as YYYY-MM-DD. */
function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function POST(request: Request) {
  let username: string;
  try {
    const body = await request.json();
    username = String(body.username ?? "").trim();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!username) {
    return NextResponse.json(
      { ok: false, error: "username is required" },
      { status: 400 },
    );
  }

  const handle = username.replace(/^@/, "").trim();
  if (!handle) {
    return NextResponse.json(
      { ok: false, error: "Invalid username" },
      { status: 400 },
    );
  }

  try {
    // 1. Load what we already have in Supabase - newest first, retention-bounded.
    const stored = await fetchDailyImpressions(handle);

    // Fast path: today's data exists and was fetched recently. Serve the
    // chart straight from storage - no X calls, no rate-limit spend.
    const newestStored = stored[0];
    if (
      newestStored &&
      newestStored.tweet_date === todayStr() &&
      newestStored.fetched_at &&
      Date.now() - new Date(newestStored.fetched_at).getTime() < FRESH_WINDOW_MS
    ) {
      const storedProfile = await profileFromStore(handle);
      // Same premium gate on the cached path: a verified account stored
      // before this check existed must not get served analytics either.
      if (storedProfile?.verified) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "You're already an X Premium member. This tool only works for non-premium accounts.",
          },
          { status: 403 },
        );
      }
      // Fetch post-level rows for the stats modal and per-metric daily breakdown.
      const storedPosts = await fetchPostRows(handle);

      // Recompute daily from stored posts so tweet_count / reply_count are
      // always consistent with the post-level source of truth (old data may
      // have been stored before the post_type fix).
      await recomputeDaily(handle);
      const freshDaily = await fetchDailyImpressions(handle);

      return NextResponse.json({
        ok: true,
        cached: true,
        profile: storedProfile ?? {
          name: handle,
          handle,
          avatar: "",
          followers: 0,
          following: 0,
          verified: false,
          bio: "",
          joined: "",
        },
        daily: freshDaily,
        posts: buildMetricDaily(storedPosts, "post"),
        replies: buildMetricDaily(storedPosts, "reply"),
        stats: computeAllStats(storedPosts),
      });
    }

    // 2. Acquire the dedicated analytics burner and look up the profile.
    const account = await acquireAnalyticsAccount();
    const client = new XSearch(account.authToken, account.ct0);

    let profile;
    try {
      profile = await client.userByScreenName(handle);
    } catch (error) {
      if (error instanceof EndpointMoved) {
        await discover(account.authToken, account.ct0);
        profile = await client.userByScreenName(handle);
      } else {
        throw error;
      }
    }

    if (!profile) {
      return NextResponse.json(
        { ok: false, error: "User not found on X" },
        { status: 404 },
      );
    }

    // This tool exists for accounts without native X analytics: blue-tick
    // (Premium) members already get it built into X, so refuse before
    // spending any burner budget on their tweets.
    if (profile.verified) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "You're already an X Premium member. This tool only works for non-premium accounts.",
        },
        { status: 403 },
      );
    }

    // 3. Fetch tweets and replies. Tweets use from:handle -filter:retweets;
    //    replies use from:handle filter:replies. Both respect the since: date
    //    so returning users don't re-scrape old pages.
    let since: string | null = null;
    if (newestStored) {
      since = daysAgoStr(2);
      if (newestStored.tweet_date > since) since = newestStored.tweet_date;
    }

    const maxPages = Number(process.env.X_MAX_PAGES ?? 8);
    const searchOpts = { maxPages, pageSize: 20, pageIntervalMs: 1500 };

    // Fetch all posts (original tweets, not retweets).
    let allPosts: Awaited<ReturnType<XSearch["search"]>>["posts"] = [];
    const postQuery = buildTimelineQuery(handle, since);
    try {
      const result = await client.search(
        postQuery, searchOpts.maxPages, searchOpts.pageSize, searchOpts.pageIntervalMs,
      );
      allPosts = result.posts;
      if (result.rateLimited) reportAnalyticsRateLimited();
    } catch (error) {
      if (error instanceof EndpointMoved) {
        await discover(account.authToken, account.ct0);
        const result = await client.search(
          postQuery, searchOpts.maxPages, searchOpts.pageSize, searchOpts.pageIntervalMs,
        );
        allPosts = result.posts;
        if (result.rateLimited) reportAnalyticsRateLimited();
      } else if (error instanceof RateLimited) {
        reportAnalyticsRateLimited();
      } else if (!(error instanceof AuthFailed)) {
        throw error;
      }
    }

    // Fetch replies separately (uses the same burner, paces itself).
    let allReplies: Awaited<ReturnType<XSearch["search"]>>["posts"] = [];
    const repliesQuery = buildRepliesQuery(handle, since);
    try {
      const result = await client.search(
        repliesQuery, searchOpts.maxPages, searchOpts.pageSize, searchOpts.pageIntervalMs,
      );
      allReplies = result.posts;
      if (result.rateLimited) reportAnalyticsRateLimited();
    } catch (error) {
      if (error instanceof EndpointMoved) {
        await discover(account.authToken, account.ct0);
        const result = await client.search(
          repliesQuery, searchOpts.maxPages, searchOpts.pageSize, searchOpts.pageIntervalMs,
        );
        allReplies = result.posts;
        if (result.rateLimited) reportAnalyticsRateLimited();
      } else if (error instanceof RateLimited) {
        reportAnalyticsRateLimited();
      } else if (!(error instanceof AuthFailed)) {
        throw error;
      }
    }

    // 4. Store fetched posts and replies as post-level rows. Re-fetched items
    //    update in place via the (handle, tweet_id) conflict key. Reply IDs
    //    are prefixed so they never collide with regular post IDs.
    const postRows: PostRow[] = allPosts
      .map((post) => {
        const d = new Date(post.created_at);
        if (Number.isNaN(d.getTime()) || !post.id) return null;
        return {
          tweet_id: post.id,
          tweet_date: d.toISOString().slice(0, 10),
          post_type: "post" as const,
          impressions: post.views,
          likes: post.likes,
          replies: post.replies,
          reposts: post.reposts,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    const replyRows: PostRow[] = allReplies
      .map((post) => {
        const d = new Date(post.created_at);
        if (Number.isNaN(d.getTime()) || !post.id) return null;
        return {
          tweet_id: `reply:${post.id}`,
          tweet_date: d.toISOString().slice(0, 10),
          post_type: "reply" as const,
          impressions: post.views,
          likes: post.likes,
          replies: post.replies,
          reposts: post.reposts,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    await upsertPosts(handle, [...postRows, ...replyRows]);

    // 5. Rebuild the per-day totals from the post rows (source of truth),
    //    then prune anything outside the retention window.
    await recomputeDaily(handle);
    await pruneOldData(handle);

    // 6. Store the profile snapshot.
    await upsertProfile({
      handle,
      name: profile.name,
      avatar: profile.avatar,
      followers: profile.followers,
      verified: profile.verified,
      last_fetched_at: new Date().toISOString(),
    });

    // 7. Read back the recomputed daily rows. If Supabase isn't migrated yet
    //    (posts table missing), the store calls no-op - fall back to daily
    //    buckets computed from this fetch so the chart still renders.
    let daily = await fetchDailyImpressions(handle);
    const allRows = [...postRows, ...replyRows];
    if (daily.length === 0 && allRows.length > 0) {
      daily = bucketFromPosts(allRows);
    }

    // Stats come from the stored post-level rows (the source of truth). If
    // Supabase isn't migrated yet the store no-ops - fall back to this
    // fetch's posts so the stats modal still renders.
    let storedPosts = await fetchPostRows(handle);
    if (storedPosts.length === 0 && allRows.length > 0) {
      storedPosts = allRows;
    }

    return NextResponse.json({
      ok: true,
      cached: false,
      profile: {
        name: profile.name,
        handle: profile.screen_name,
        avatar: profile.avatar,
        followers: profile.followers,
        following: profile.following,
        verified: profile.verified,
        bio: profile.bio,
        joined: profile.joined,
      },
      daily,
      posts: buildMetricDaily(storedPosts, "post"),
      replies: buildMetricDaily(storedPosts, "reply"),
      stats: computeAllStats(storedPosts),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[analytics]", message);
    const status = error instanceof AuthFailed
      ? 401
      : error instanceof RateLimited
        ? 429
        : 502;
    // Surface config problems (missing burner session) so the operator knows
    // what to fix; hide X internals from end users.
    const friendly =
      message.includes("No analytics session configured")
        ? "Analytics burner not configured on the server - set X_ANALYTICS_AUTH_TOKEN_1 / X_ANALYTICS_CT0_1 (and _2)"
        : error instanceof AuthFailed
          ? "X rejected the session - refresh the analytics burner cookies"
          : error instanceof RateLimited
            ? "Rate limit reached. Please try again later."
            : "Try again later.";
    return NextResponse.json({ ok: false, error: friendly }, { status });
  }
}

/** Build per-day totals for a specific metric (impressions, posts, or replies)
 *  from post-level rows. Used to return metric-specific daily arrays so the
 *  frontend can switch between them without recomputing. */
function buildMetricDaily(
  posts: PostRow[],
  metric: "impressions" | "post" | "reply",
): Array<{ tweet_date: string; value: number }> {
  const byDay = new Map<string, number>();
  for (const p of posts) {
    const existing = byDay.get(p.tweet_date) ?? 0;
    if (metric === "impressions") {
      byDay.set(p.tweet_date, existing + p.impressions);
    } else if (metric === "post") {
      byDay.set(p.tweet_date, existing + (p.post_type === "post" ? 1 : 0));
    } else {
      byDay.set(p.tweet_date, existing + (p.post_type === "reply" ? 1 : 0));
    }
  }
  return [...byDay.entries()]
    .map(([tweet_date, value]) => ({ tweet_date, value }))
    .sort((a, b) => b.tweet_date.localeCompare(a.tweet_date));
}

/** Collapse post rows into per-day totals, newest-first (used only when the
 *  Supabase migration hasn't been applied yet). */
function bucketFromPosts(
  posts: Array<{ tweet_id: string; tweet_date: string; impressions: number; post_type?: string }>,
): Array<{
  tweet_date: string;
  tweet_count: number;
  reply_count: number;
  total_impressions: number;
}> {
  const byDay = new Map<string, { count: number; replies: number; total: number }>();
  for (const p of posts) {
    const existing = byDay.get(p.tweet_date) ?? { count: 0, replies: 0, total: 0 };
    existing.count += 1;
    if (p.post_type === "reply") existing.replies += 1;
    existing.total += p.impressions;
    byDay.set(p.tweet_date, existing);
  }
  return [...byDay.entries()]
    .map(([tweet_date, agg]) => ({
      tweet_date,
      tweet_count: agg.count,
      reply_count: agg.replies,
      total_impressions: agg.total,
    }))
    .sort((a, b) => b.tweet_date.localeCompare(a.tweet_date));
}

/** Best-effort profile read from the profiles table (used on the cached path
 *  so a returning user still sees their header without an X call). */
async function profileFromStore(
  handle: string,
): Promise<{
  name: string;
  handle: string;
  avatar: string;
  followers: number;
  verified: boolean;
  bio: string;
  joined: string;
} | null> {
  try {
    if (!isSupabaseConfigured()) return null;
    const client = serverClient();
    const { data, error } = await client
      .from("x_analytics_profiles")
      .select("handle, name, avatar, followers, verified")
      .eq("handle", handle.toLowerCase())
      .single();
    if (error || !data) return null;
    const row = data as {
      handle: string;
      name: string;
      avatar: string;
      followers: number;
      verified: boolean;
    };
    return {
      name: row.name,
      handle: row.handle,
      avatar: row.avatar,
      followers: row.followers,
      verified: row.verified,
      bio: "",
      joined: "",
    };
  } catch {
    return null;
  }
}
