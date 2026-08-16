// Diagnostic: reproduce exactly one X SearchTimeline request the way
// src/lib/x/search.ts makes it, and print which failure mode applies.
//
// Usage: node --env-file=.env.local scripts/diagnose-x-search.mjs
// One request on the dedicated discovery account. Safe to run repeatedly.
import { readFileSync } from "node:fs";

const BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D" +
  "1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

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

const ID = "hyPfJYJ_XAtDYoslQc-Rgg"; // SearchTimeline fallback from endpoints.ts

const authToken = (process.env.X_DISCOVERY_AUTH_TOKEN ?? "").trim();
const ct0 = (process.env.X_DISCOVERY_CT0 ?? "").trim();

if (!authToken || !ct0) {
  console.log("RESULT: discovery account NOT configured in this environment");
  console.log("  X_DISCOVERY_AUTH_TOKEN and/or X_DISCOVERY_CT0 are missing.");
  console.log("  If this is the deployed env, that alone explains all-zero scan logs.");
  process.exit(0);
}
console.log("discovery account: configured (token/ct0 present, lengths", authToken.length, ct0.length + ")");

const queries = JSON.parse(
  readFileSync(new URL("../src/lib/x/discoveryQueries.json", import.meta.url), "utf8"),
);
const query = queries[0];
console.log("query[0]:", query.slice(0, 80) + (query.length > 80 ? "..." : ""));

const variables = { rawQuery: query, count: 50, querySource: "typed_query", product: "Latest" };
const body = JSON.stringify({ variables, features: FEATURES, queryId: ID });

const headers = {
  Authorization: `Bearer ${BEARER}`,
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Content-Type": "application/json",
  "X-Csrf-Token": ct0,
  "X-Twitter-Auth-Type": "OAuth2Session",
  "X-Twitter-Active-User": "yes",
  "X-Twitter-Client-Language": "en",
  Referer: "https://x.com/",
  Cookie: `auth_token=${authToken}; ct0=${ct0}`,
};

const url = `https://x.com/i/api/graphql/${ID}/SearchTimeline`;
const response = await fetch(url, { method: "POST", headers, body });
const text = await response.text();
console.log("HTTP", response.status, "for", url);

if (response.status === 401 || response.status === 403) {
  console.log("RESULT: X REJECTED THE SESSION (AuthFailed)");
  console.log("  The discovery auth_token/ct0 is invalid or expired - refresh it");
  console.log("  from a logged-in browser session and update the env vars.");
  process.exit(0);
}
if (response.status === 404) {
  console.log("RESULT: 404 - the SearchTimeline queryId is STALE/ROTATED");
  console.log("  X rotates queryIds on deploy. endpoints.ts discover() is only wired");
  console.log("  into the impressions flow, not the discovery scan - so the scan");
  console.log("  cannot self-heal. Refresh the queryId (or wire discover() in).");
  process.exit(0);
}
if (response.status === 429) {
  console.log("RESULT: 429 - the discovery account is rate limited right now");
  process.exit(0);
}
if (!response.ok) {
  console.log("RESULT: unexpected status - not one of the handled modes");
  process.exit(0);
}

const entryMatches = text.match(/"entries"/g) ?? [];
console.log("body bytes:", text.length, "| 'entries' occurrences:", entryMatches.length);

let payload;
try {
  payload = JSON.parse(text);
} catch {
  console.log("RESULT: response body is NOT JSON - X returned something unexpected");
  console.log("  snippet:", text.slice(0, 300));
  process.exit(0);
}

if (payload.errors?.length) {
  console.log("RESULT: X returned a GraphQL errors array:");
  for (const e of payload.errors) console.log("  -", JSON.stringify(e).slice(0, 200));
  process.exit(0);
}

// Count tweet entries and check the parse path used by XSearch.parsePost.
function walk(node, key, out) {
  if (Array.isArray(node)) for (const item of node) walk(item, key, out);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      walk(v, key, out);
    }
  }
}
const entries = [];
walk(payload, "entries", entries);
const tweetEntries = entries
  .flat()
  .filter((e) => String(e?.entryId ?? "").startsWith("tweet"));

console.log("tweet entries returned:", tweetEntries.length);

if (tweetEntries.length === 0) {
  console.log("RESULT: query returned ZERO tweet entries - no parse issue, the search");
  console.log("  itself matched nothing. (Possible if X search results are quiet, but");
  console.log("  if this is true for ALL 9 queries on every run, the query syntax or");
  console.log("  the account's search visibility is the issue.)");
  process.exit(0);
}

// Walk the first entry down the exact path parsePost uses.
const sample = tweetEntries[0];
let result = sample?.content?.itemContent?.tweet_results?.result;
if (result?.tweet) result = result.tweet;
const legacy = result?.legacy;
const core = result?.core;
const userResults = core?.user_results?.result?.core;

console.log("first entry parses via parsePost path:",
  Boolean(legacy && legacy.full_text),
  "| has core.user_results:", Boolean(userResults));
console.log("sample text:", (legacy?.full_text ?? "(none)").slice(0, 100));

if (!legacy) {
  console.log("RESULT: X CHANGED THE RESPONSE SHAPE - parsePost can no longer read it.");
  console.log("  The scan runs, queries succeed, but 0 posts parse -> all-zero logs.");
} else {
  console.log("RESULT: parser path OK - X returned", tweetEntries.length,
    "parseable posts. If deployed scans still log zeros,");
  console.log("  the cause is environmental (missing/expired discovery credentials on");
  console.log("  the host, or a stale queryId there), not the response shape.");
}
