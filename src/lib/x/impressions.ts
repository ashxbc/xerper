import * as cache from "./cache";
import { reportRateLimited, reserveAccount } from "./accounts";
import { discover } from "./endpoints";
import { EndpointMoved, XSearch, type Post, type UserFields } from "./search";

/** Serverless caps how long a request may run, so the page budget is tighter
 *  than the old CLI's 25. Override with X_MAX_PAGES if your host allows more. */
const MAX_PAGES = Number(process.env.X_MAX_PAGES ?? 12);

export type Payload = {
  ok: true;
  username: string;
  project: string;
  query: string;
  profile: UserFields;
  project_profile: UserFields | null;
  post_count: number;
  total_impressions: number;
  series: Array<{ t: string; v: number }>;
  partial: boolean;
  cached: boolean;
  posts: Post[];
};

/** Build an X search query for a user's posts mentioning a project.
 *
 *  A project may arrive as a handle (@base), a bare word (base) or a
 *  multi-word name (Base Club), so match the mention, the hashtag and the
 *  plain word to catch every way it gets referenced.
 */
export function buildQuery(username: string, project: string): string {
  const user = username.replace(/^@/, "").trim();
  const proj = project.replace(/^@/, "").trim();

  let terms: string[];
  if (/^[A-Za-z0-9_]+$/.test(proj)) {
    terms = [`@${proj}`, `#${proj}`, proj];
  } else {
    terms = [`"${proj}"`];
    const squashed = proj.replace(/[^A-Za-z0-9]/g, "");
    if (squashed) terms.push(`#${squashed}`);
  }

  const seen = new Set<string>();
  const unique = terms.filter((term) => {
    const key = term.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Retweets carry the original author's view count, not the user's own work
  return `from:${user} (${unique.join(" OR ")}) -filter:retweets`;
}

/** Cumulative impressions over time, oldest first.
 *
 *  Impressions only ever accumulate, so the running total is the honest shape
 *  for "growth" - plotting per-post views would just be a spiky bar chart of
 *  individual posts, not a trajectory.
 */
export function growthSeries(posts: Post[]) {
  const dated = posts
    .map((post) => ({ at: new Date(post.created_at), views: post.views }))
    .filter((entry) => !Number.isNaN(entry.at.getTime()))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  let running = 0;
  return dated.map((entry) => {
    running += entry.views;
    return { t: entry.at.toISOString().slice(0, 10), v: running };
  });
}

export async function fetchImpressions(
  username: string,
  project: string,
): Promise<Payload> {
  const query = buildQuery(username, project);
  const handle = username.replace(/^@/, "");

  // A repeat of the same card costs nothing and spends no rate limit
  const key = `${handle.toLowerCase()}|${project.replace(/^@/, "").toLowerCase()}`;
  const cached = cache.get<Payload>("impressions", key);
  if (cached) return { ...cached, cached: true };

  // Round-robin across the burner pool; throws RateLimited immediately if
  // all three accounts are already busy this second.
  const account = reserveAccount();
  const client = new XSearch(account.authToken, account.ct0);

  let result;
  try {
    result = await client.search(query, MAX_PAGES);
  } catch (error) {
    if (!(error instanceof EndpointMoved)) throw error;
    // X rotated the SearchTimeline query ID - rediscover it and retry once
    const ids = await discover(account.authToken, account.ct0);
    if (!ids.SearchTimeline) {
      throw new Error(
        "X moved the search endpoint and the new ID could not be found",
      );
    }
    result = await client.search(query, MAX_PAGES);
  }

  const { posts, rateLimited } = result;

  // X 429'd this specific burner - cool it down instead of retrying it
  // every second while the other accounts keep serving traffic.
  if (rateLimited) reportRateLimited(account.id);

  // Resolve the project's own account for its icon (cached separately, so it
  // survives the shorter lifetime of the results above)
  const projectProfile = await client.resolveProject(project);

  for (const post of posts) {
    post.url = `https://x.com/${post.screen_name || handle}/status/${post.id}`;
  }

  const payload: Payload = {
    ok: true,
    username: handle,
    project: project.replace(/^@/, ""),
    query,
    profile: client.profile ?? {
      name: handle,
      screen_name: handle,
      avatar: "",
      followers: 0,
      verified: false,
    },
    project_profile: projectProfile,
    post_count: posts.length,
    total_impressions: posts.reduce((sum, post) => sum + post.views, 0),
    series: growthSeries(posts),
    partial: rateLimited,
    cached: false,
    posts,
  };

  // Don't cache a truncated run - it would pin a wrong total for the TTL
  if (!rateLimited) {
    cache.set("impressions", key, payload, cache.TTL_IMPRESSIONS);
  }
  return payload;
}
