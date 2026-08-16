import * as cache from "./cache";
import { queryId, USER_AGENT } from "./endpoints";

/** Minimal X search client.
 *
 *  Ported from Python so the whole app can deploy as one Node service -
 *  serverless has no Python runtime, no pip install and a read-only disk.
 *
 *  Talks to X's GraphQL endpoints directly rather than through a wrapper
 *  library; the notes below record what the current API actually requires,
 *  since each one cost a debugging session:
 *
 *   - SearchTimeline answers on POST only. A GET returns a bodyless 404 that
 *     looks exactly like a bad query ID.
 *   - The "load older" cursor arrives inside `entries` on page one but as a
 *     TimelineReplaceEntry with a singular `entry` on later pages. Reading
 *     only `entries` silently caps pagination at two pages.
 *   - User objects no longer carry a `legacy` block; name and handle moved to
 *     `core`, the avatar to `avatar`, verification to `verification`.
 *   - X-Client-Transaction-Id is not enforced, so we do not compute one.
 */

// X's public web bearer - the same token the site ships to browsers
const BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D" +
  "1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// X rejects the call outright if these are not all present
const FEATURES = {
  creator_subscriptions_tweet_preview_api_enabled: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  rweb_video_timestamps_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  responsive_web_media_download_video_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

export class AuthFailed extends Error {}
export class RateLimited extends Error {}
export class EndpointMoved extends Error {}

export type Post = {
  id: string;
  screen_name: string;
  created_at: string;
  views: number;
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  text: string;
  url?: string;
  // Author snapshot at post time - undefined when the search result didn't
  // carry a resolvable user object. Used to spot low-follower accounts.
  author_name?: string;
  author_avatar?: string;
  author_followers?: number;
  author_verified?: boolean;
};

export type UserFields = {
  name: string;
  screen_name: string;
  avatar: string;
  // Empty string when the account has no banner set - X omits the field
  // entirely rather than sending a placeholder URL.
  banner: string;
  followers: number;
  following: number;
  verified: boolean;
  bio: string;
  // Raw X-format timestamp (e.g. "Wed Oct 10 20:19:24 +0000 2018") - format
  // it for display at the point of use rather than here.
  joined: string;
};

type Json = Record<string, unknown>;

/** Yield every value stored under `key`, at any depth. */
function* walk(node: unknown, key: string): Generator<unknown> {
  if (Array.isArray(node)) {
    for (const item of node) yield* walk(item, key);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) yield v;
      yield* walk(v, key);
    }
  }
}

export function toInt(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number.parseInt(String(value).replace(/,/g, ""), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Pull every tweet's full_text out of x.com's embedded Relay payload. The
 *  status page embeds the whole conversation (root + replies) as a stream of
 *  $R[] assignments, each carrying a full_text:"..." field - joining them in
 *  page order reconstructs the thread. Returns an empty array when the page
 *  has no parseable tweets. */
export function extractThreadTexts(html: string, maxTweets = 25): string[] {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const match of html.matchAll(/full_text:"((?:[^"\\]|\\.)*)"/g)) {
    let text = match[1]
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
    text = text.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    texts.push(text);
    if (texts.length >= maxTweets) break;
  }
  return texts;
}

/** Find the "load older results" cursor, in either shape X uses. */
function bottomCursor(payload: unknown): string | null {
  for (const content of walk(payload, "content")) {
    const c = content as Json | null;
    if (
      c &&
      typeof c === "object" &&
      c.__typename === "TimelineTimelineCursor" &&
      c.cursorType === "Bottom"
    ) {
      return (c.value as string) ?? null;
    }
  }
  return null;
}

export class XSearch {
  /** Filled from the first result; the search response already carries the
   *  author's profile, so no separate profile lookup is needed. */
  profile: UserFields | null = null;

  private headers: Record<string, string>;

  constructor(authToken: string, ct0: string) {
    this.headers = {
      Authorization: `Bearer ${BEARER}`,
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
      "X-Csrf-Token": ct0,
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Active-User": "yes",
      "X-Twitter-Client-Language": "en",
      Referer: "https://x.com/",
      Cookie: `auth_token=${authToken}; ct0=${ct0}`,
    };
  }

  private async post(
    query: string,
    cursor: string | null,
    count: number,
    product: "Latest" | "People" = "Latest",
  ): Promise<Json> {
    const variables: Json = {
      rawQuery: query,
      count,
      querySource: "typed_query",
      product,
    };
    if (cursor) variables.cursor = cursor;

    const id = queryId("SearchTimeline");
    const response = await fetch(
      `https://x.com/i/api/graphql/${id}/SearchTimeline`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ variables, features: FEATURES, queryId: id }),
      },
    );

    if (response.status === 401 || response.status === 403) {
      throw new AuthFailed(
        "X rejected the session - refresh X_AUTH_TOKEN and X_CT0 from a " +
          "logged-in browser",
      );
    }
    if (response.status === 429) throw new RateLimited("rate limited by X");
    if (response.status === 404) throw new EndpointMoved("search endpoint moved");
    if (!response.ok) {
      throw new Error(`X returned ${response.status}`);
    }
    return (await response.json()) as Json;
  }

  /** Fetch the full text of one tweet URL, including the author's own thread
   *  when the tweet is part of one. Uses this session's GraphQL API: first
   *  TweetDetail (the same query X's status page uses - it returns the whole
   *  conversation), then filters to the author's own tweets from the URL's
   *  handle, oldest first. Falls back to TweetResultByRestId (single tweet)
   *  when TweetDetail is unavailable.
   *
   *  Handles x.com/twitter.com/vxtwitter/fxtwitter URLs. Throws RateLimited on
   *  a 429, AuthFailed on 401/403, EndpointMoved on a rotated query ID
   *  (callers can heal + retry via endpoints.discover), and a plain Error for
   *  any other failure. */
  async fetchStatusThread(url: string): Promise<string> {
    const match = url.match(/\/status\/(\d+)/);
    const handleMatch = url.match(/\.com\/([A-Za-z0-9_]{1,15})\/status\//);
    if (!match) throw new Error(`Not a tweet URL: ${url}`);
    const tweetId = match[1];
    const handle = handleMatch?.[1]?.toLowerCase() ?? "";

    // TweetDetail's variables must include the feature switches and field
    // toggles X's own client sends, or the query fails validation (422).
    const detailVariables = {
      focalTweetId: tweetId,
      with_rux_injections: false,
      includePromotedContent: true,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: true,
      withBirdwatchPivots: false,
      withVoice: true,
      withV2Timeline: false,
      withBirdwatchNotes: true,
    };

    const detail = await this.graphqlGet(
      "TweetDetail",
      detailVariables,
    );
    if (detail) {
      const tweets = XSearch.conversationTweets(detail);
      if (tweets.length > 0) {
        const authorTweets = handle
          ? tweets
              .filter((t) => t.screen_name.toLowerCase() === handle)
              .sort((a, b) => a.createdAt - b.createdAt)
          : tweets;
        if (authorTweets.length > 0) {
          return authorTweets.map((t) => t.text).join("\n\n");
        }
      }
    }

    // Fallback: single-tweet fetch by ID.
    const single = await this.tweetById(tweetId);
    return single.text;
  }

  /** GET a GraphQL query with this session's headers. Returns null on any
   *  non-200 (including 422 validation failures when X rotates the schema),
   *  so callers can fall back rather than surface the platform's internals. */
  private async graphqlGet(
    operation: string,
    variables: Json,
  ): Promise<Json | null> {
    const id = queryId(operation);
    if (!id) return null;
    const params = new URLSearchParams({
      variables: JSON.stringify(variables),
      features: JSON.stringify(FEATURES),
      fieldToggles: JSON.stringify({}),
    });

    let response: Response;
    try {
      response = await fetch(
        `https://x.com/i/api/graphql/${id}/${operation}?${params}`,
        { headers: this.headers, signal: AbortSignal.timeout(30_000) },
      );
    } catch (error) {
      throw new Error(
        `X ${operation} failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthFailed(
        "X rejected the session - refresh X_DISCOVERY_AUTH_TOKEN and " +
          "X_DISCOVERY_CT0 from a logged-in browser",
      );
    }
    if (response.status === 429) throw new RateLimited("rate limited by X");
    if (response.status === 404) {
      throw new EndpointMoved(`${operation} endpoint moved`);
    }
    if (!response.ok) return null;
    return (await response.json()) as Json;
  }

  /** Pull every tweet out of a TweetDetail response, deduped by ID, with
   *  author handle and created-at (epoch ms) for thread reconstruction. */
  private static conversationTweets(
    payload: Json,
  ): Array<{ id: string; screen_name: string; createdAt: number; text: string }> {
    const tweets: Array<{ id: string; screen_name: string; createdAt: number; text: string }> = [];
    const seen = new Set<string>();
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(visit);
      } else if (node && typeof node === "object") {
        const record = node as Json;
        const legacy = record.legacy as Json | undefined;
        if (legacy && record.rest_id) {
          const id = String(record.rest_id);
          const text = String(legacy.full_text ?? "").trim();
          if (text && !seen.has(id)) {
            seen.add(id);
            const userResults = (record.core as Json)?.user_results as Json | undefined;
            const userResult = userResults?.result as Json | undefined;
            const screenName = String(
              (userResult?.core as Json | undefined)?.screen_name ??
                (userResult?.legacy as Json | undefined)?.screen_name ??
                "",
            );
            tweets.push({
              id,
              screen_name: screenName,
              createdAt: new Date(String(legacy.created_at ?? "")).getTime() || 0,
              text,
            });
          }
        }
        Object.values(record).forEach(visit);
      }
    };
    visit(payload);
    return tweets;
  }

  /** Fetch a single tweet by ID (TweetResultByRestId). */
  private async tweetById(
    tweetId: string,
  ): Promise<{ text: string }> {
    const payload = await this.graphqlGet("TweetResultByRestId", {
      tweetId,
      with_rux_injections: false,
      includePromotedContent: true,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: true,
      withBirdwatchPivots: false,
      withVoice: true,
      withV2Timeline: false,
    });
    if (!payload) {
      throw new Error(
        `Tweet ${tweetId} could not be fetched (the endpoint may have changed)`,
      );
    }
    const result = (payload.data as Json)?.tweetResult as Json | undefined;
    const tweet = result?.result as Json | undefined;
    if (!tweet) {
      // 200 with no tweetResult: the tweet ID doesn't exist (or is private/
      // deleted) - the API answers 200 with a null result rather than 404.
      throw new Error(`Tweet ${tweetId} not found - it may be deleted or private`);
    }
    const text = String((tweet.legacy as Json)?.full_text ?? "").trim();
    if (!text) throw new Error(`Tweet ${tweetId} has no text`);
    return { text };
  }

  /** Page through results, returning the posts and whether X cut us off. */
  async search(
    query: string,
    maxPages: number,
    pageSize = 20,
    pageIntervalMs = 0,
  ): Promise<{ posts: Post[]; rateLimited: boolean }> {
    const posts: Post[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    let rateLimited = false;

    for (let page = 0; page < maxPages; page++) {
      if (page > 0 && pageIntervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, pageIntervalMs));
      }

      let payload: Json;
      try {
        payload = await this.post(query, cursor, pageSize);
      } catch (error) {
        if (error instanceof RateLimited) {
          rateLimited = true;
          break;
        }
        throw error;
      }

      const entries: Json[] = [];
      for (const group of walk(payload, "entries")) {
        if (Array.isArray(group)) entries.push(...(group as Json[]));
      }
      if (entries.length === 0) break;

      const nextCursor = bottomCursor(payload);
      let fresh = 0;

      for (const entry of entries) {
        const entryId = String(entry.entryId ?? "");
        if (!entryId.startsWith("tweet")) continue;

        const post = XSearch.parsePost(entry);
        if (post && !seen.has(post.id)) {
          seen.add(post.id);
          posts.push(post);
          fresh++;
          this.profile ??= XSearch.parseProfile(entry);
        }
      }

      // X returned entries but none of them parsed - the response schema has
      // probably changed under us. Shout about it, because it makes a scan
      // look like "quiet" when it actually found plenty.
      if (fresh === 0 && entries.length > 0) {
        console.warn(
          `[x] SearchTimeline returned ${entries.length} entries for query ` +
            `"${query.slice(0, 80)}" but 0 parsed as posts - X likely changed ` +
            "the response shape",
        );
      }

      // No new posts, or nowhere left to go
      if (fresh === 0 || !nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }

    return { posts, rateLimited };
  }

  // ---- project identity ---------------------------------------------------

  /** Find the X account behind a project name, for its icon.
   *
   *  Prefer the account the user is actually already crediting: scan the
   *  posts just fetched for an @mention starting with the project name -
   *  "hana" matches @hana or @hana_something - and resolve that handle's
   *  real profile. Falls back to the old name-search heuristic (exact
   *  handle lookup + people search, scored by follower count) only when no
   *  post mentions the project by handle at all.
   */
  async resolveProject(
    project: string,
    posts: Post[] = [],
  ): Promise<UserFields | null> {
    const key = project.replace(/^@/, "").trim().toLowerCase();
    if (!key) return null;

    const hit = cache.get<UserFields | Record<string, never>>("project", key);
    if (hit) return "screen_name" in hit ? (hit as UserFields) : null;

    const fromMention = await this.resolveFromMentions(key, posts);
    if (fromMention) {
      cache.set("project", key, fromMention, cache.TTL_PROJECT);
      return fromMention;
    }

    const candidates: UserFields[] = [];
    const slug = key.replace(/[^a-z0-9_]/g, "");
    if (slug) {
      const exact = await this.userByScreenName(slug);
      if (exact) candidates.push(exact);
    }
    candidates.push(...(await this.searchPeople(key)));

    const best = XSearch.bestMatch(key, candidates);
    cache.set("project", key, best ?? {}, cache.TTL_PROJECT);
    return best;
  }

  /** Look for @handle mentions in the posts where the handle starts with
   *  the project name - "hana" matches @hana and @hana_something alike.
   *  An exact @hana wins outright; otherwise whichever @hana* variant is
   *  mentioned most often is used. Returns null (triggering the fallback
   *  search) if no post mentions anything starting with the project name. */
  private async resolveFromMentions(
    key: string,
    posts: Post[],
  ): Promise<UserFields | null> {
    const normalise = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const target = normalise(key);
    if (!target) return null;

    const counts = new Map<string, number>();
    for (const post of posts) {
      for (const match of post.text.matchAll(/@(\w{1,15})/g)) {
        const handle = match[1];
        if (!normalise(handle).startsWith(target)) continue;
        counts.set(handle, (counts.get(handle) ?? 0) + 1);
      }
    }
    if (counts.size === 0) return null;

    const ranked = [...counts.entries()].sort((a, b) => {
      const aExact = normalise(a[0]) === target;
      const bExact = normalise(b[0]) === target;
      if (aExact !== bExact) return aExact ? -1 : 1;
      return b[1] - a[1];
    });

    for (const [handle] of ranked) {
      const profile = await this.userByScreenName(handle);
      if (profile) return profile;
    }
    return null;
  }

  private static bestMatch(
    query: string,
    candidates: UserFields[],
  ): UserFields | null {
    const normalise = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const target = normalise(query);
    if (!target) return null;

    let best: UserFields | null = null;
    let bestScore = 0;

    for (const user of candidates) {
      const handle = normalise(user.screen_name);
      const name = normalise(user.name);

      // Exact on either field is the strong signal, and it is what separates
      // the two hard cases: @Calderaxyz is named exactly "Caldera" (so it
      // beats the 156-follower @caldera), while @archillect merely starts
      // with "arc" and must not win on follower count alone.
      const exact = handle === target || name === target;
      // Never a bare substring - "arc" sits inside "Archive". Prefixes are
      // only trustworthy once the query is long enough to be distinctive.
      const prefix =
        target.length >= 5 &&
        (handle.startsWith(target) || name.startsWith(target));
      if (!exact && !prefix) continue;

      let score = Math.log10(Math.max(user.followers, 1)) * 2;
      // Large enough that an exact match outranks a prefix unless the prefix
      // account has ~10,000x the audience
      score += exact ? 8 : 1.5;
      if (user.verified) score += 1;

      if (score > bestScore) {
        best = user;
        bestScore = score;
      }
    }
    return best;
  }

  /** Public lookup by handle - used by the impressions flow internally, and
   *  by the discovery scan to resolve a candidate handle's profile (and bio)
   *  directly rather than through a fuzzy name search. */
  async userByScreenName(handle: string): Promise<UserFields | null> {
    const id = queryId("UserByScreenName");
    const params = new URLSearchParams({
      variables: JSON.stringify({
        screen_name: handle,
        withSafetyModeUserFields: true,
      }),
      features: JSON.stringify(FEATURES),
    });

    try {
      const response = await fetch(
        `https://x.com/i/api/graphql/${id}/UserByScreenName?${params}`,
        { headers: this.headers },
      );
      // Let the caller know this account is really rate-limited, rather than
      // reporting it as an ordinary failed lookup - callers use this to stop
      // burning more requests on a cooling-down account.
      if (response.status === 429) {
        throw new RateLimited("rate limited by X");
      }
      // A hard 404 means X rotated this GraphQL operation's query ID (a
      // nonexistent handle comes back as 200 with a null result, not 404).
      // Throw so callers can rediscover the ID instead of silently skipping
      // every candidate.
      if (response.status === 404) {
        throw new EndpointMoved("UserByScreenName endpoint moved");
      }
      if (!response.ok) {
        console.error(
          `[x] UserByScreenName(${handle}) returned ${response.status}`,
        );
        return null;
      }
      const data = (await response.json()) as Json;
      const user = (data.data as Json)?.user as Json | undefined;
      const fields = XSearch.userFields(user?.result as Json | undefined);
      if (!fields) {
        console.error(
          `[x] UserByScreenName(${handle}) had no parseable user object`,
        );
      }
      return fields;
    } catch (error) {
      if (error instanceof RateLimited || error instanceof EndpointMoved) {
        throw error;
      }
      console.error(
        `[x] UserByScreenName(${handle}) failed:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  private async searchPeople(query: string): Promise<UserFields[]> {
    let payload: Json;
    try {
      payload = await this.post(query, null, 10, "People");
    } catch {
      return [];
    }

    const users: UserFields[] = [];
    for (const holder of walk(payload, "user_results")) {
      const result = (holder as Json)?.result as Json | undefined;
      const fields = XSearch.userFields(result);
      if (fields) users.push(fields);
    }
    return users;
  }

  private static userFields(user: Json | undefined): UserFields | null {
    if (!user || !user.core) return null;
    const core = user.core as Json;
    const avatar = String((user.avatar as Json)?.image_url ?? "");
    // Bio lives under profile_bio in the current schema; legacy is a
    // defensive fallback in case an account still serves the older shape.
    const bio = String(
      (user.profile_bio as Json)?.description ??
        (user.legacy as Json)?.description ??
        "",
    );
    // Banner has stayed under legacy across the schema moves that relocated
    // avatar/bio; the other two keys are speculative fallbacks in case it
    // moves the same way.
    const banner = String(
      (user.legacy as Json)?.profile_banner_url ??
        (user.profile_banner as Json)?.image_url ??
        (user.banner as Json)?.image_url ??
        "",
    );
    return {
      name: String(core.name ?? ""),
      screen_name: String(core.screen_name ?? ""),
      // _normal is a 48px thumbnail; _400x400 is the crisp version
      avatar: avatar.replace("_normal.", "_400x400."),
      banner,
      bio,
      followers: toInt((user.relationship_counts as Json)?.followers),
      following: toInt(
        (user.relationship_counts as Json)?.following ??
          (user.legacy as Json)?.friends_count,
      ),
      verified: Boolean((user.verification as Json)?.verified),
      joined: String(core.created_at ?? (user.legacy as Json)?.created_at ?? ""),
    };
  }

  private static tweetResult(entry: Json): Json | null {
    const content = entry.content as Json | undefined;
    const itemContent = content?.itemContent as Json | undefined;
    const results = itemContent?.tweet_results as Json | undefined;
    let result = results?.result as Json | undefined;
    if (!result) return null;
    // Visibility-limited posts nest the real payload one level down
    if (result.tweet) result = result.tweet as Json;
    return result;
  }

  private static parseProfile(entry: Json): UserFields | null {
    const result = XSearch.tweetResult(entry);
    if (!result) return null;
    const core = result.core as Json | undefined;
    const userResults = core?.user_results as Json | undefined;
    return XSearch.userFields(userResults?.result as Json | undefined);
  }

  private static parsePost(entry: Json): Post | null {
    const result = XSearch.tweetResult(entry);
    if (!result) return null;

    const legacy = result.legacy as Json | undefined;
    if (!legacy) return null;

    const core = result.core as Json | undefined;
    const userResults = core?.user_results as Json | undefined;
    const author = XSearch.userFields(userResults?.result as Json | undefined);

    return {
      id: String(result.rest_id ?? legacy.id_str ?? ""),
      screen_name: author?.screen_name ?? "",
      created_at: String(legacy.created_at ?? ""),
      // X reports views as a string
      views: toInt((result.views as Json)?.count),
      likes: toInt(legacy.favorite_count),
      reposts: toInt(legacy.retweet_count),
      replies: toInt(legacy.reply_count),
      quotes: toInt(legacy.quote_count),
      text: String(legacy.full_text ?? ""),
      author_name: author?.name,
      author_avatar: author?.avatar,
      author_followers: author?.followers,
      author_verified: author?.verified,
    };
  }
}
