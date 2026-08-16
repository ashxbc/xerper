import * as cache from "./cache";

/** X embeds a `queryId` for every GraphQL operation in its JS bundles and
 *  rotates them on each deploy. Hardcoding one means the app breaks silently a
 *  few weeks later with a bodyless 404. So we ship a last-known-good value and
 *  re-scrape the bundles whenever a call 404s. */

export const FALLBACKS: Record<string, string> = {
  SearchTimeline: "hyPfJYJ_XAtDYoslQc-Rgg",
  UserByScreenName: "Gb-d6r0vxPOADdG62OEBpQ",
  // Single-tweet fetch by ID (used by the Telegram bot to read a pasted
  // tweet URL through the discovery burner).
  TweetResultByRestId: "GZsN2Pc4knAoit6pXa4HSA",
  // Full conversation fetch - the query X's own status page uses; the bot
  // reads the author's thread out of it.
  TweetDetail: "XMOz5h24KAZ86qKffKTLdQ",
};

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const NAMESPACE = "queryId";
const TTL = 12 * 3600 * 1000;

// Bundles declare operations in either field order
const PATTERNS: Array<{ re: RegExp; opFirst: boolean }> = [
  { re: /queryId:"([\w-]{15,})",operationName:"(\w+)"/g, opFirst: false },
  { re: /operationName:"(\w+)",queryId:"([\w-]{15,})"/g, opFirst: true },
];

export function queryId(operation: string): string {
  return (
    cache.get<string>(NAMESPACE, operation) ?? FALLBACKS[operation] ?? ""
  );
}

/** Scrape current query IDs from X's bundles. Needs a logged-in session: the
 *  logged-out page ships a slimmer bundle without the operation table. */
export async function discover(
  authToken: string,
  ct0: string,
): Promise<Record<string, string>> {
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: `auth_token=${authToken}; ct0=${ct0}`,
  };

  const home = await fetch("https://x.com/home", { headers });
  const html = await home.text();

  const scripts = new Set<string>();
  for (const match of html.matchAll(
    /src="(https:\/\/abs\.twimg\.com[^"]+\.js)"/g,
  )) {
    scripts.add(match[1]);
  }
  for (const match of html.matchAll(/"(\/x-web\/[^"]+?\.js)"/g)) {
    scripts.add(`https://abs.twimg.com${match[1]}`);
  }

  const found: Record<string, string> = {};

  await Promise.all(
    [...scripts].map(async (url) => {
      let body: string;
      try {
        body = await (await fetch(url, { headers })).text();
      } catch {
        return;
      }
      for (const { re, opFirst } of PATTERNS) {
        for (const match of body.matchAll(re)) {
          const operation = opFirst ? match[1] : match[2];
          const id = opFirst ? match[2] : match[1];
          found[operation] = id;
        }
      }
    }),
  );

  for (const [operation, id] of Object.entries(found)) {
    cache.set(NAMESPACE, operation, id, TTL);
  }
  return found;
}
