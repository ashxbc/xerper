#!/usr/bin/env node
/**
 * One-off dev tool: pulls real profile data (name, avatar, banner, bio,
 * followers, following, verified, joined) for the preloaded gems from X and
 * regenerates supabase/seed.sql so the site renders complete profiles before
 * the first scheduled scan runs.
 *
 * Run from the project root:
 *   node --env-file=.env.local scripts/refresh-seed.mjs
 *
 * Uses the main burner pool (X_AUTH_TOKEN_1/X_CT0_1) at 1 req/sec - the same
 * pacing the app enforces itself. Never prints credentials.
 */

import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---- constants mirrored from src/lib/x/search.ts + endpoints.ts -------------
const BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D" +
  "1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Last-known-good query ID (src/lib/x/endpoints.ts FALLBACKS).
const USER_BY_SCREEN_NAME_ID = "Gb-d6r0vxPOADdG62OEBpQ";

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

// The 5 verified pre-mint projects from the last discovery run.
const HANDLES = [
  "the_tempAgency",
  "MoankeeAuction",
  "NibblinsNFT",
  "Miu_nft",
  "glorpRBH",
];

const REQUEST_INTERVAL_MS = 1100;

// ---- tiny helpers ----------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toInt(value) {
  const parsed = Number.parseInt(String(value ?? "").replace(/,/g, ""), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

/** Mirrors XSearch.userFields() in src/lib/x/search.ts. */
function userFields(user) {
  if (!user || !user.core) return null;
  const core = user.core;
  const avatar = String(user.avatar?.image_url ?? "");
  const bio = String(
    user.profile_bio?.description ?? user.legacy?.description ?? "",
  );
  const banner = String(
    user.legacy?.profile_banner_url ??
      user.profile_banner?.image_url ??
      user.banner?.image_url ??
      "",
  );
  return {
    name: String(core.name ?? ""),
    screen_name: String(core.screen_name ?? ""),
    avatar: avatar.replace("_normal.", "_400x400."),
    banner,
    bio,
    followers: toInt(user.relationship_counts?.followers),
    following: toInt(
      user.relationship_counts?.following ?? user.legacy?.friends_count,
    ),
    verified: Boolean(user.verification?.verified),
    joined: String(core.created_at ?? user.legacy?.created_at ?? ""),
  };
}

async function fetchProfile(authToken, ct0, handle) {
  const params = new URLSearchParams({
    variables: JSON.stringify({
      screen_name: handle,
      withSafetyModeUserFields: true,
    }),
    features: JSON.stringify(FEATURES),
  });

  const response = await fetch(
    `https://x.com/i/api/graphql/${USER_BY_SCREEN_NAME_ID}/UserByScreenName?${params}`,
    {
      headers: {
        Authorization: `Bearer ${BEARER}`,
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "X-Csrf-Token": ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes",
        "X-Twitter-Client-Language": "en",
        Referer: "https://x.com/",
        Cookie: `auth_token=${authToken}; ct0=${ct0}`,
      },
    },
  );

  if (response.status === 429) {
    throw new Error(`X rate limited us (429) while fetching @${handle}`);
  }
  if (!response.ok) {
    throw new Error(
      `X returned ${response.status} while fetching @${handle}`,
    );
  }

  const data = await response.json();
  const result = data?.data?.user?.result;
  const fields = userFields(result);
  if (!fields) {
    throw new Error(`No parseable profile for @${handle}`);
  }
  return fields;
}

// ---- main ------------------------------------------------------------------
function credentials() {
  const token = process.env.X_AUTH_TOKEN_1 ?? process.env.X_AUTH_TOKEN;
  const ct0 = process.env.X_CT0_1 ?? process.env.X_CT0;
  if (!token || !ct0) {
    throw new Error(
      "No X session configured - set X_AUTH_TOKEN_1/X_CT0_1 in .env.local",
    );
  }
  return { token, ct0 };
}

async function main() {
  const { token, ct0 } = credentials();

  const rows = [];
  for (const handle of HANDLES) {
    const profile = await fetchProfile(token, ct0, handle);
    console.log(
      `@${handle}: ${profile.name || "(no name)"} - ${profile.followers} followers - ` +
        `verified=${profile.verified} - banner=${profile.banner ? "yes" : "no"}`,
    );
    rows.push({ handle: profile.screen_name.toLowerCase(), profile });
    await sleep(REQUEST_INTERVAL_MS);
  }

  const values = rows
    .map(({ handle, profile }) => {
      const p = profile;
      return `  ('${sqlEscape(handle)}', '${sqlEscape(p.name)}', ` +
        `'${sqlEscape(p.avatar)}', '${sqlEscape(p.banner)}', ` +
        `'${sqlEscape(p.bio)}', ${p.followers}, ${p.following}, ` +
        `${p.verified}, '${sqlEscape(p.joined)}', true, 'added', true, ` +
        `now(), now(), now())`;
    })
    .join(",\n");

  const sql = `-- Preload the projects already vetted as TRUE by the discovery scan.\n` +
    `-- Regenerated by scripts/refresh-seed.mjs - do not edit by hand.\n` +
    `-- Idempotent: re-running refreshes the profile fields of existing rows.\n` +
    `insert into public.nft_projects (\n` +
    `  handle, name, avatar, banner, bio, followers, following, verified, joined,\n` +
    `  is_nft_project, status, processed, discovered_at, added_at, processed_at\n` +
    `)\nvalues\n${values}\n` +
    `on conflict ((lower(handle))) do update set\n` +
    `  name = excluded.name,\n` +
    `  avatar = excluded.avatar,\n` +
    `  banner = excluded.banner,\n` +
    `  bio = excluded.bio,\n` +
    `  followers = excluded.followers,\n` +
    `  following = excluded.following,\n` +
    `  verified = excluded.verified,\n` +
    `  joined = excluded.joined,\n` +
    `  status = excluded.status,\n` +
    `  processed = excluded.processed,\n` +
    `  updated_at = now();\n`;

  const out = resolve(dirname(fileURLToPath(import.meta.url)), "../supabase/seed.sql");
  await writeFile(out, sql, "utf8");
  console.log(`\nWrote ${rows.length} rows to ${out}`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
