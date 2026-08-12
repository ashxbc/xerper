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
};

export type UserFields = {
  name: string;
  screen_name: string;
  avatar: string;
  followers: number;
  verified: boolean;
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

  /** Page through results, returning the posts and whether X cut us off. */
  async search(
    query: string,
    maxPages: number,
    pageSize = 20,
  ): Promise<{ posts: Post[]; rateLimited: boolean }> {
    const posts: Post[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    let rateLimited = false;

    for (let page = 0; page < maxPages; page++) {
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

      // No new posts, or nowhere left to go
      if (fresh === 0 || !nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }

    return { posts, rateLimited };
  }

  // ---- project identity ---------------------------------------------------

  /** Find the X account behind a project name, for its icon.
   *
   *  Taking the matching handle at face value gets this wrong often: for
   *  "caldera", @caldera is a 156-follower account while the actual project is
   *  @Calderaxyz with 328k. So gather candidates from both an exact handle
   *  lookup and a people search, then score them - a project's real account is
   *  the one with the audience.
   */
  async resolveProject(project: string): Promise<UserFields | null> {
    const key = project.replace(/^@/, "").trim().toLowerCase();
    if (!key) return null;

    const hit = cache.get<UserFields | Record<string, never>>("project", key);
    if (hit) return "screen_name" in hit ? (hit as UserFields) : null;

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

  private async userByScreenName(handle: string): Promise<UserFields | null> {
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
      if (!response.ok) return null;
      const data = (await response.json()) as Json;
      const user = (data.data as Json)?.user as Json | undefined;
      return XSearch.userFields(user?.result as Json | undefined);
    } catch {
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
    return {
      name: String(core.name ?? ""),
      screen_name: String(core.screen_name ?? ""),
      // _normal is a 48px thumbnail; _400x400 is the crisp version
      avatar: avatar.replace("_normal.", "_400x400."),
      followers: toInt((user.relationship_counts as Json)?.followers),
      verified: Boolean((user.verification as Json)?.verified),
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
    const userCore = (userResults?.result as Json | undefined)?.core as
      | Json
      | undefined;

    return {
      id: String(result.rest_id ?? legacy.id_str ?? ""),
      screen_name: String(userCore?.screen_name ?? ""),
      created_at: String(legacy.created_at ?? ""),
      // X reports views as a string
      views: toInt((result.views as Json)?.count),
      likes: toInt(legacy.favorite_count),
      reposts: toInt(legacy.retweet_count),
      replies: toInt(legacy.reply_count),
      quotes: toInt(legacy.quote_count),
      text: String(legacy.full_text ?? ""),
    };
  }
}
