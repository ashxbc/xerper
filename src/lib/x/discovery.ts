import type { PersistenceStats } from "../gems-store";
import { persistScanRun } from "../gems-store";
import * as cache from "./cache";
import { acquireDiscoveryAccount, reportDiscoveryRateLimited } from "./accounts";
import { classifyNftProject } from "../groq";
import { RateLimited, XSearch, type Post } from "./search";
import discoveryQueries from "./discoveryQueries.json";

/** Scans a fixed set of high-intent NFT-launch search queries, then
 *  classifies whatever low-follower accounts turn up as a real NFT project
 *  or not, using Groq.
 *
 *  Two cases per matching post:
 *   1. With no tagged account, the poster is treated as the project candidate.
 *   2. When the post tags accounts, those handles are treated as the project
 *      candidates instead of the promoter who posted the launch copy.
 *
 *  Every candidate handle is resolved to a real profile and must be under
 *  1,000 followers before anything else happens - that's the whole "still
 *  pre-hype" signal. Only then do we pull its bio and most recent tweet and
 *  hand exactly those three fields (handle, bio, tweet) to Groq to decide
 *  true/false. Runs entirely on the dedicated discovery account (see
 *  lib/x/accounts.ts) so it never competes with the impressions pool.
 */

const QUERIES: string[] = discoveryQueries;

// Scan budget, read from env so it can be tuned per host without code
// changes. Vercel's Hobby plan caps function duration at 300s, and each
// discovery request is deliberately paced at 5s for account health, so the
// defaults below keep a full scan inside that window. Raise the limits (and
// the routes' maxDuration) if you upgrade or self-host.
const MAX_FOLLOWERS = Number(process.env.DISCOVERY_MAX_FOLLOWERS ?? 1000);
const PAGES_PER_QUERY = Number(process.env.DISCOVERY_PAGES ?? 2);
const PAGE_SIZE = Number(process.env.DISCOVERY_PAGE_SIZE ?? 50);
// SearchTimeline pagination happens inside one XSearch call and therefore
// cannot use acquireDiscoveryAccount() between pages; pace those requests
// explicitly at the same conservative interval as individual lookups.
const PAGE_INTERVAL_MS = 5000;
// Every unvouched candidate costs a profile lookup, maybe a tweet fetch, and
// a Groq call. Evaluate at most 25 unique handles per completed round.
const MAX_CANDIDATES = Number(process.env.DISCOVERY_MAX_CANDIDATES ?? 25);
// Hard wall-clock cap so the scan always finishes inside the host's function
// timeout (Vercel Hobby = 300s) and can persist + log its results. When X
// turns up unusually many eligible accounts, this stops the scan instead of
// letting the function be killed mid-run with nothing stored.
const SCAN_TIME_BUDGET_MS = Number(process.env.DISCOVERY_TIME_BUDGET_MS ?? 240_000);
const DISCOVERY_CACHE_KEY = "premint-v1";
const VERDICT_CACHE_NAMESPACE = "discovery-verdict-premint-v1";

export type DiscoveryVerdict = {
  handle: string;
  name: string;
  avatar: string;
  banner: string;
  followers: number;
  following: number;
  verified: boolean;
  joined: string;
  bio: string;
  recent_tweet: string;
  is_nft_project: boolean;
  source_query: string;
  seen_in_post_url: string;
};

export type DiscoveryResult = {
  ok: true;
  // Present after a scan that actually ran and was persisted to Supabase -
  // undefined on cache hits and when persistence was skipped/disabled.
  persistence?: PersistenceStats;
  generated_at: string;
  follower_threshold: number;
  queries_total: number;
  queries_run: number;
  queries_skipped: number;
  posts_scanned: number;
  candidates_considered: number;
  candidates_lookup_failed: number;
  candidates_over_follower_limit: number;
  candidates_already_minting: number;
  candidates_classification_failed: number;
  // True when X 429'd the dedicated discovery account partway through this
  // run. The scan stops immediately rather than sitting on the 15-minute
  // cooldown inline, so this run's result is partial - retry later.
  rate_limited: boolean;
  projects: DiscoveryVerdict[];
  rejected: DiscoveryVerdict[];
};

function extractMentions(text: string): string[] {
  const handles = new Set<string>();
  for (const match of text.matchAll(/@(\w{1,15})/g)) {
    handles.add(match[1]);
  }
  return [...handles];
}

// Deterministic safety net before Groq. Keep "minting soon", "mint in 24h",
// and similar future language out of this list; these patterns only describe
// a mint that has begun or ended already.
const STARTED_MINT_PATTERNS = [
  /\bmint(?:ing)?\s+(?:is\s+)?live\b/i,
  /\b(?:now|currently)\s+minting\b/i,
  /\bmint(?:ing)?\s+(?:has\s+)?started\b/i,
  /\bmint(?:ed)?\s*out\b/i,
  /\b(?:fully\s+)?sold\s*out\b/i,
  /\bpublic\s+mint\s+(?:is\s+)?(?:live|open|started)\b/i,
  /\bpresale\s+(?:is\s+)?(?:live|open|started)\b/i,
  /\bmint\s+(?:is\s+)?(?:open|closed|complete|completed|ended)\b/i,
  /\b\d[\d,]*\s*\/\s*\d[\d,]*\s+minted\b/i,
];

function hasStartedMinting(bio: string, recentTweet: string): boolean {
  const evidence = `${bio}\n${recentTweet}`;
  if (STARTED_MINT_PATTERNS.some((pattern) => pattern.test(evidence))) return true;

  // A direct OpenSea URL is an additional conservative signal that a
  // collection is already issued/trading. t.co links cannot be identified
  // without another network lookup, so only explicit URLs are considered.
  return /(?:https?:\/\/)?(?:www\.)?opensea\.io\//i.test(evidence);
}

let discoveryInFlight: Promise<DiscoveryResult> | null = null;

/** Run the discovery scan, returning the cached result when available.
 *
 *  Concurrent callers collapse onto one shared run, so React Strict Mode's
 *  double-mount cannot launch two multi-minute scans on one burner.
 *
 *  Options:
 *   - force: bypass the cache and always rescan (used by the scheduled run).
 *   - persist: write this run's projects and a scan-log row to Supabase once
 *     the scan finishes (default true; a shared run persists exactly once).
 *   - logId: id of a 'running' gems_scan_logs row to finalize instead of
 *     inserting a new one (the scheduled run opens it before scanning). */
export async function runDiscovery(
  options: { force?: boolean; persist?: boolean; logId?: number } = {},
): Promise<DiscoveryResult> {
  if (!options.force) {
    const cached = cache.get<DiscoveryResult>("discovery", DISCOVERY_CACHE_KEY);
    if (cached) return cached;
  }
  if (discoveryInFlight) return discoveryInFlight;

  discoveryInFlight = (async () => {
    const result = await scanDiscovery();
    if (options.persist !== false) {
      try {
        result.persistence = await persistScanRun(result, options.logId);
      } catch (error) {
        console.error(
          "[discovery] failed to persist scan to Supabase:",
          error instanceof Error ? error.message : error,
        );
      }
    }
    return result;
  })();
  try {
    return await discoveryInFlight;
  } finally {
    discoveryInFlight = null;
  }
}

async function scanDiscovery(): Promise<DiscoveryResult> {
  const startedAt = Date.now();
  const evaluated = new Map<string, DiscoveryVerdict>();
  const candidates = new Map<string, { handle: string; query: string; post: Post }>();
  let queriesRun = 0;
  let queriesSkipped = 0;
  let postsScanned = 0;
  let candidatesConsidered = 0;
  // Once X 429s the single discovery account, acquireDiscoveryAccount() would
  // otherwise block the rest of this call for the full 15-minute cooldown -
  // this flag stops the scan the moment that happens instead.
  let rateLimited = false;
  const stats: CandidateStats = {
    lookupFailed: 0,
    overFollowerLimit: 0,
    alreadyMinting: 0,
    classificationFailed: 0,
  };

  // Search every fixed query before applying the classification budget. This
  // keeps one busy query from preventing the remaining discovery themes from
  // being scanned at all.
  for (const query of QUERIES) {
    if (rateLimited) break;
    if (Date.now() - startedAt > SCAN_TIME_BUDGET_MS) {
      console.log("[discovery] time budget reached - skipping remaining queries");
      break;
    }

    let result;
    try {
      const account = await acquireDiscoveryAccount();
      const client = new XSearch(account.authToken, account.ct0);
      result = await client.search(
        query,
        PAGES_PER_QUERY,
        PAGE_SIZE,
        PAGE_INTERVAL_MS,
      );
    } catch (error) {
      if (error instanceof RateLimited) {
        rateLimited = true;
        console.warn("[discovery] discovery account is cooling down - stopping scan");
        break;
      }
      console.error(
        "[discovery] search failed:",
        query,
        error instanceof Error ? error.message : error,
      );
      queriesSkipped++;
      continue;
    }
    queriesRun++;
    postsScanned += result.posts.length;
    if (result.rateLimited) {
      rateLimited = true;
      reportDiscoveryRateLimited();
      console.warn("[discovery] rate limited by X - stopping scan early");
    }

    for (const post of result.posts) {
      const mentions = extractMentions(post.text);
      // A launch post that tags another account is promotion for the tagged
      // project (case 2), not evidence that the posting account is a project.
      // Evaluate the author only when the post contains no tagged candidate
      // (case 1). This prevents copy-pasting promoters from becoming projects.
      const handles = mentions.length > 0 ? mentions : [post.screen_name];

      for (const handle of handles) {
        if (!handle) continue;
        const key = handle.toLowerCase();
        if (!candidates.has(key)) {
          candidates.set(key, { handle, query, post });
        }
      }
    }
  }

  for (const candidate of candidates.values()) {
    if (rateLimited) break;
    if (candidatesConsidered >= MAX_CANDIDATES) break;
    // Leave headroom for this candidate's own paced lookups (up to two) plus
    // the final persistence write, so the run always completes inside the
    // host's function timeout and actually gets stored + logged.
    if (Date.now() - startedAt > SCAN_TIME_BUDGET_MS - 20_000) {
      console.log(
        "[discovery] time budget reached - stopping candidate evaluation",
      );
      break;
    }
    candidatesConsidered++;

    try {
      const verdict = await evaluateCandidate(
        candidate.handle,
        candidate.query,
        candidate.post,
        stats,
      );
      if (verdict) evaluated.set(candidate.handle.toLowerCase(), verdict);
    } catch (error) {
      if (!(error instanceof RateLimited)) throw error;
      rateLimited = true;
      reportDiscoveryRateLimited();
      console.warn("[discovery] rate limited by X - stopping scan early");
    }
  }

  const all = [...evaluated.values()];
  const projects = all.filter((v) => v.is_nft_project);
  const rejected = all.filter((v) => !v.is_nft_project);

  for (const v of projects) {
    console.log(`[discovery] TRUE  @${v.handle} (${v.followers} followers) - ${v.bio}`);
  }
  for (const v of rejected) {
    console.log(`[discovery] FALSE @${v.handle} (${v.followers} followers) - ${v.bio}`);
  }

  console.log(
    `[discovery] considered ${candidatesConsidered} candidates - ` +
      `${stats.lookupFailed} lookup failed, ` +
      `${stats.overFollowerLimit} over follower limit, ` +
      `${stats.alreadyMinting} already minting/minted, ` +
      `${stats.classificationFailed} classification failed, ` +
      `${projects.length} true, ${rejected.length} false` +
      (rateLimited ? " - stopped early: rate limited by X" : ""),
  );

  const output: DiscoveryResult = {
    ok: true,
    generated_at: new Date().toISOString(),
    follower_threshold: MAX_FOLLOWERS,
    queries_total: QUERIES.length,
    queries_run: queriesRun,
    queries_skipped: queriesSkipped,
    posts_scanned: postsScanned,
    candidates_considered: candidatesConsidered,
    candidates_lookup_failed: stats.lookupFailed,
    candidates_over_follower_limit: stats.overFollowerLimit,
    candidates_already_minting: stats.alreadyMinting,
    candidates_classification_failed: stats.classificationFailed,
    rate_limited: rateLimited,
    projects,
    rejected,
  };

  // MAX_CANDIDATES is the scan's intentional classification boundary, not an
  // incomplete run. Cache it so each Gems page load does not rescan all of X.
  // Actual partial runs (failed queries or a 429) are still never cached.
  if (queriesSkipped === 0 && !rateLimited) {
    cache.set("discovery", DISCOVERY_CACHE_KEY, output, cache.TTL_DISCOVERY);
  }
  return output;
}

type CandidateStats = {
  lookupFailed: number;
  overFollowerLimit: number;
  alreadyMinting: number;
  classificationFailed: number;
};

/** Resolve one candidate handle, gate it on follower count, and classify it.
 *  Returns null for anything that doesn't clear the follower bar or that
 *  couldn't be classified. `rejected` is reserved for successful Groq false
 *  verdicts; lookup failures, over-limit profiles, and provider failures are
 *  tracked as skips in `stats` instead of being mislabeled as classifier
 *  decisions. */
async function evaluateCandidate(
  handle: string,
  query: string,
  seedPost: Post,
  stats: CandidateStats,
): Promise<DiscoveryVerdict | null> {
  const cacheKey = handle.toLowerCase();
  const cachedVerdict = cache.get<DiscoveryVerdict>(VERDICT_CACHE_NAMESPACE, cacheKey);
  if (cachedVerdict) return cachedVerdict;

  // Case 1 candidates (the poster themselves) already carry their follower
  // count in the search result - skip the profile lookup when they're over
  // the bar, since lookups are the expensive part of the scan (and the
  // dominant cause of Hobby function timeouts). Mentioned handles (case 2)
  // still need the lookup. The live gate below remains the final word.
  if (
    seedPost.screen_name.toLowerCase() === handle.toLowerCase() &&
    seedPost.author_followers !== undefined &&
    seedPost.author_followers >= MAX_FOLLOWERS
  ) {
    stats.overFollowerLimit++;
    console.log(
      `[discovery] SKIP  @${handle} - ${seedPost.author_followers} followers (limit ${MAX_FOLLOWERS}, from search result)`,
    );
    return null;
  }

  const account = await acquireDiscoveryAccount();
  const client = new XSearch(account.authToken, account.ct0);

  // A RateLimited here is intentionally left uncaught - it propagates up to
  // runDiscovery's candidate loop, which stops the whole scan rather than
  // treating one 429 as a normal lookup failure.
  const profile = await client.userByScreenName(handle);
  if (!profile) {
    stats.lookupFailed++;
    console.log(`[discovery] SKIP  @${handle} - profile lookup failed`);
    return null;
  }

  // Hard gate, before anything else runs (no tweet fetch, no Groq call).
  if (profile.followers >= MAX_FOLLOWERS) {
    stats.overFollowerLimit++;
    console.log(
      `[discovery] SKIP  @${profile.screen_name} - ${profile.followers} followers (limit ${MAX_FOLLOWERS})`,
    );
    return null;
  }

  // The seed post is already this candidate's own tweet in case 1; in case
  // 2 (a mentioned handle) we need a fresh lookup for their latest post.
  let recentTweet: string;
  if (profile.screen_name.toLowerCase() === seedPost.screen_name.toLowerCase()) {
    recentTweet = seedPost.text;
  } else {
    const tweetAccount = await acquireDiscoveryAccount();
    const tweetClient = new XSearch(tweetAccount.authToken, tweetAccount.ct0);
    let recentResult;
    try {
      recentResult = await tweetClient.search(`from:${handle}`, 1, 1);
    } catch {
      recentResult = { posts: [] as Post[], rateLimited: false };
    }
    // XSearch.search() already converts a 429 into rateLimited:true rather
    // than throwing - surface it the same way userByScreenName does, so the
    // caller stops the scan instead of treating it as a normal empty result.
    if (recentResult.rateLimited) {
      reportDiscoveryRateLimited();
      throw new RateLimited("rate limited by X");
    }
    recentTweet = recentResult.posts[0]?.text ?? "";
  }

  let isNftProject: boolean;
  if (hasStartedMinting(profile.bio, recentTweet)) {
    stats.alreadyMinting++;
    isNftProject = false;
    console.log(
      `[discovery] FALSE @${profile.screen_name} - mint is live, started, completed, or already on OpenSea`,
    );
  } else {
    try {
      // Exactly these three fields go to Groq - nothing else about the
      // account (followers, avatar, verification, etc.) is sent.
      isNftProject = await classifyNftProject({
        handle: profile.screen_name,
        bio: profile.bio,
        recentTweet,
      });
    } catch (error) {
      stats.classificationFailed++;
      console.error(
        "[discovery] classification failed for",
        handle,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  const verdict: DiscoveryVerdict = {
    handle: profile.screen_name,
    name: profile.name,
    avatar: profile.avatar,
    banner: profile.banner,
    followers: profile.followers,
    following: profile.following,
    verified: profile.verified,
    joined: profile.joined,
    bio: profile.bio,
    recent_tweet: recentTweet,
    is_nft_project: isNftProject,
    source_query: query,
    seen_in_post_url: `https://x.com/${seedPost.screen_name}/status/${seedPost.id}`,
  };

  cache.set(VERDICT_CACHE_NAMESPACE, cacheKey, verdict, cache.TTL_DISCOVERY_VERDICT);
  return verdict;
}
