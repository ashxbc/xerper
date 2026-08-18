import { RateLimited } from "./search";

/** Burner-account pool.
 *
 *  X rate-limits per session, not per IP, so one burner tops out around
 *  1 request/sec before it starts eating 429s. Spreading load across three
 *  burners round-robin gets the app to ~3 req/sec in aggregate without any
 *  single account looking like it's hammering the API.
 *
 *  Accounts are configured as X_AUTH_TOKEN_1/X_CT0_1, _2, _3. The old
 *  unindexed X_AUTH_TOKEN/X_CT0 still works as a single-account fallback.
 */

export type Account = {
  id: string;
  authToken: string;
  ct0: string;
};

type AccountState = {
  account: Account;
  /** Timestamp after which this account may be handed out again. */
  nextAvailableAt: number;
};

// One request per second per user-facing account - three accounts, three
// req/sec total. Discovery uses a deliberately slower dedicated pace below.
const MIN_INTERVAL_MS = 1000;
const DISCOVERY_MIN_INTERVAL_MS = 5000;
// X's own 429 means the burner is actually rate-limited, not just our own
// pacing - back it off hard rather than retrying it every second.
const COOLDOWN_ON_429_MS = 15 * 60 * 1000;

let pool: AccountState[] | null = null;
let cursor = 0;

function loadAccounts(): Account[] {
  const accounts: Account[] = [];

  for (let i = 1; i <= 3; i++) {
    const authToken = (process.env[`X_AUTH_TOKEN_${i}`] ?? "").trim();
    const ct0 = (process.env[`X_CT0_${i}`] ?? "").trim();
    if (authToken && ct0) accounts.push({ id: `burner-${i}`, authToken, ct0 });
  }

  // Back-compat: a lone unindexed pair still works as a single burner
  if (accounts.length === 0) {
    const authToken = (process.env.X_AUTH_TOKEN ?? "").trim();
    const ct0 = (process.env.X_CT0 ?? "").trim();
    if (authToken && ct0) accounts.push({ id: "burner-1", authToken, ct0 });
  }

  return accounts;
}

function getPool(): AccountState[] {
  if (!pool) pool = loadAccounts().map((account) => ({ account, nextAvailableAt: 0 }));
  return pool;
}

/** Reset the pool - only needed by tests, since accounts are otherwise read
 *  once from env and cached for the life of the instance. */
export function resetPool(): void {
  pool = null;
  cursor = 0;
}

export function accountCount(): number {
  return getPool().length;
}

/** Reserve the next free burner, round-robin. Throws RateLimited if every
 *  configured account is already spoken for this second (or cooling down
 *  from a real 429), so callers can surface that to the user immediately
 *  instead of queueing requests up. */
export function reserveAccount(): Account {
  const states = getPool();
  if (states.length === 0) {
    throw new Error(
      "No X session configured - set X_AUTH_TOKEN_1/X_CT0_1 " +
        "(and _2, _3 for the rest of the pool) environment variables",
    );
  }

  const now = Date.now();
  for (let i = 0; i < states.length; i++) {
    const index = (cursor + i) % states.length;
    const state = states[index];
    if (state.nextAvailableAt <= now) {
      state.nextAvailableAt = now + MIN_INTERVAL_MS;
      cursor = (index + 1) % states.length;
      return state.account;
    }
  }

  throw new RateLimited(
    "All burner accounts are busy right now - try again in a moment",
  );
}

/** Called after X itself 429s a burner, so the pool stops offering it up
 *  until the cooldown passes rather than immediately re-throttling it. */
export function reportRateLimited(accountId: string): void {
  const state = getPool().find((s) => s.account.id === accountId);
  if (state) state.nextAvailableAt = Date.now() + COOLDOWN_ON_429_MS;
}

// ---- dedicated discovery account ------------------------------------------
// A separate 4th burner just for the background NFT-discovery scan, so it
// never competes with the 3-account pool above for budget a real user's
// request might need. Configured independently as X_DISCOVERY_AUTH_TOKEN /
// X_DISCOVERY_CT0.

let discoveryState: AccountState | null | undefined;
let discoveryCooldownUntil = 0;

function getDiscoveryState(): AccountState | null {
  if (discoveryState !== undefined) return discoveryState;

  const authToken = (process.env.X_DISCOVERY_AUTH_TOKEN ?? "").trim();
  const ct0 = (process.env.X_DISCOVERY_CT0 ?? "").trim();
  discoveryState =
    authToken && ct0
      ? { account: { id: "discovery", authToken, ct0 }, nextAvailableAt: 0 }
      : null;
  return discoveryState;
}

/** True when the dedicated discovery burner is configured. The scan refuses
 *  to run without it - a missing pair of env vars would otherwise look like
 *  a quiet scan that found nothing. */
export function isDiscoveryConfigured(): boolean {
  return getDiscoveryState() !== null;
}

/** Reset the discovery account's cached state - only needed by tests. */
export function resetDiscoveryAccount(): void {
  discoveryState = undefined;
  discoveryCooldownUntil = 0;
}

/** Wait for, then reserve, the dedicated discovery burner. Unlike
 *  reserveAccount(), this waits out its own pacing instead of failing fast:
 *  the discovery scan is a background job with no user waiting on it, and
 *  there is no second account to fall back to, so a short pause between
 *  queries is the right trade-off over skipping queries outright. */
export async function acquireDiscoveryAccount(): Promise<Account> {
  const state = getDiscoveryState();
  if (!state) {
    throw new Error(
      "No discovery session configured - set X_DISCOVERY_AUTH_TOKEN and " +
        "X_DISCOVERY_CT0 environment variables",
    );
  }

  const now = Date.now();
  // A short wait enforces discovery's conservative 5-second pacing. A real X
  // 429 uses the separate cooldown marker and must fail fast, otherwise a request
  // appears frozen for as long as 15 minutes.
  if (discoveryCooldownUntil > now) {
    throw new RateLimited("Discovery account is cooling down after an X 429");
  }

  const wait = state.nextAvailableAt - now;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

  state.nextAvailableAt = Date.now() + DISCOVERY_MIN_INTERVAL_MS;
  return state.account;
}

/** Called after X itself 429s the discovery burner - same cooldown as the
 *  main pool. */
export function reportDiscoveryRateLimited(): void {
  const state = getDiscoveryState();
  discoveryCooldownUntil = Date.now() + COOLDOWN_ON_429_MS;
  if (state) state.nextAvailableAt = discoveryCooldownUntil;
}

// ---- dedicated analytics accounts -----------------------------------------
// Two burners used exclusively by the X Analytics tool (impressions /
// posts / replies bar-chart). They never compete with the 3-account
// pool above or the discovery burner below. Requests rotate between
// the two accounts with 1-second pacing each, giving ~2 req/sec
// aggregate throughput while staying well under X's per-session limits.
// If both accounts are busy the caller waits (async queue) instead of
// failing fast — the user is already watching a loading spinner.

const ANALYTICS_MIN_INTERVAL_MS = 1000;
let analyticsCooldownUntil = 0;

let analyticsPool: AccountState[] | null = null;
let analyticsCursor = 0;

function loadAnalyticsAccounts(): Account[] {
  const accounts: Account[] = [];
  for (let i = 1; i <= 2; i++) {
    const authToken = (
      process.env[`X_ANALYTICS_AUTH_TOKEN_${i}`] ?? ""
    ).trim();
    const ct0 = (process.env[`X_ANALYTICS_CT0_${i}`] ?? "").trim();
    if (authToken && ct0)
      accounts.push({ id: `analytics-${i}`, authToken, ct0 });
  }
  // Back-compat: a lone unindexed pair still works as a single burner
  if (accounts.length === 0) {
    const authToken = (
      process.env.X_ANALYTICS_AUTH_TOKEN ?? ""
    ).trim();
    const ct0 = (process.env.X_ANALYTICS_CT0 ?? "").trim();
    if (authToken && ct0)
      accounts.push({ id: "analytics-1", authToken, ct0 });
  }
  return accounts;
}

function getAnalyticsPool(): AccountState[] {
  if (!analyticsPool)
    analyticsPool = loadAnalyticsAccounts().map((account) => ({
      account,
      nextAvailableAt: 0,
    }));
  return analyticsPool;
}

/** Wait for, then reserve, one of the two analytics burners.
 *
 *  Unlike the user-facing `reserveAccount()` which fails fast when all
 *  accounts are busy, analytics callers tolerate a short wait because the
 *  user is already behind a loading spinner. The function round-robins
 *  between accounts and sleeps until the next one becomes available.
 *
 *  When a real X 429 hits, the pool is drained via `reportAnalyticsRate-
 *  Limited()` so both accounts cool down. */
export async function acquireAnalyticsAccount(): Promise<Account> {
  const states = getAnalyticsPool();
  if (states.length === 0) {
    throw new Error(
      "No analytics session configured - set X_ANALYTICS_AUTH_TOKEN_1 / " +
        "X_ANALYTICS_CT0_1 (and _2 for the second account) environment variables",
    );
  }

  if (analyticsCooldownUntil > Date.now()) {
    throw new RateLimited(
      "Analytics accounts are cooling down after an X 429. Please try again later.",
    );
  }

  // Find the next available account; if none are free yet, wait for the
  // soonest one rather than failing outright.
  let bestIdx = -1;
  let bestWait = Infinity;
  for (let i = 0; i < states.length; i++) {
    const idx = (analyticsCursor + i) % states.length;
    const wait = states[idx].nextAvailableAt - Date.now();
    if (wait <= 0) {
      bestIdx = idx;
      bestWait = 0;
      break;
    }
    if (wait < bestWait) {
      bestIdx = idx;
      bestWait = wait;
    }
  }

  if (bestWait > 0) {
    await new Promise((resolve) => setTimeout(resolve, bestWait));
  }

  states[bestIdx].nextAvailableAt = Date.now() + ANALYTICS_MIN_INTERVAL_MS;
  analyticsCursor = (bestIdx + 1) % states.length;
  return states[bestIdx].account;
}

/** Called after X itself 429s any analytics burner — both accounts go into
 *  cooldown since they share a rate-limit pool per IP/session class. */
export function reportAnalyticsRateLimited(): void {
  analyticsCooldownUntil = Date.now() + COOLDOWN_ON_429_MS;
  for (const state of getAnalyticsPool()) {
    state.nextAvailableAt = analyticsCooldownUntil;
  }
}
