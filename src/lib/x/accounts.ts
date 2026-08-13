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

// One request per second per account - three accounts, three req/sec total.
const MIN_INTERVAL_MS = 1000;
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
