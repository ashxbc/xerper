# Xerper

Next.js 16 app that turns X (Twitter) activity into shareable "proof of work"
cards, plus an **Alpha Terminal** that surfaces pre-mint NFT projects found by
scanning X. The discovery scan runs automatically every 3 hours and stores
everything in Supabase so the site always reflects the latest gems.

## Stack

- Next.js 16 (App Router), React 19, Tailwind CSS 4
- X's internal GraphQL endpoints via a pool of burner accounts
- Groq (LLM) classifies candidate accounts as NFT projects or not
- Supabase (Postgres) stores discovered projects + every scan run

## Getting started

```bash
npm install
npm run dev
```

Environment: copy `.env.local.example` to `.env.local` and fill in:

- **X burners** - `X_AUTH_TOKEN_1..3` / `X_CT0_1..3` (plus optional
  `X_DISCOVERY_AUTH_TOKEN` / `X_DISCOVERY_CT0` for the dedicated discovery
  burner), `PYTHON_BIN` (unused legacy), `GROQ_API_KEY`, `DISCOVERY_SECRET`.
- **Supabase** - see below.

## Supabase setup (gems storage)

1. Create a free project at <https://supabase.com>.
2. Open the **SQL Editor** and run `supabase/schema.sql` - creates two tables:
   - `nft_projects` - every discovered project. `handle` (lowercased) is the
     unique dedup key; `status` is `added` (published to the site) or
     `rejected`; `discovered_at` / `added_at` / `processed` record the
     lifecycle so duplicates can never be re-added.
   - `gems_scan_logs` - one row per scan run (success/partial/failed, how many
     projects were found / new / skipped as duplicates, error details).
3. Run `supabase/seed.sql` to preload the 5 verified projects already found
   (so the site renders gems before the first scheduled scan). Idempotent.
4. Add these env vars (see `supabase/.env.example`):
   - `NEXT_PUBLIC_SUPABASE_URL` - Project Settings > API > Project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` - API > anon public
   - `SUPABASE_SERVICE_ROLE_KEY` - API > service_role (**server only**, never
     in the browser)
   - `CRON_SECRET` - any random string guarding the scan endpoint

No RLS policies are needed: the site never talks to Supabase from the browser.
All reads/writes go through API routes using the service-role key server-side.

## Scheduling the scan (every 3 hours)

**The scan runs directly inside the GitHub Actions job - no HTTP endpoint is
involved.** A full scan takes 4-10 minutes at the conservative 5s/request
pacing, and a multi-minute HTTP request fails on the free tier (an edge in
front of Vercel returns 524 once it gives up waiting, and the function itself
is capped at 300s). The Actions VM has a 6-hour budget, so the job does the
scanning itself: it talks to X on the discovery burner, classifies with Groq,
and writes results + a `gems_scan_logs` row straight to Supabase.

`.github/workflows/gems-scan.yml` declares the `0 */3 * * *` schedule. Add
**five secrets** in the repo (Settings > Secrets and variables > Actions):

- `X_DISCOVERY_AUTH_TOKEN` + `X_DISCOVERY_CT0` - the dedicated discovery
  burner (same values as the local `.env.local` ones - and note these must be
  fresh/valid: X rejects expired sessions with 401/403, which fails the scan)
- `GROQ_API_KEY` - candidate classifier
- `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` - storage (the
  service-role key is safe here: it lives in a private repo secret, never in
  the client)

The workflow runs `scripts/run-scan.ts` (via `tsx`), which logs a `running`
row first and finalizes it when the scan finishes - exactly like the old
endpoint. `GEMS_RUN_URL` / `CRON_SECRET` are **no longer needed** for the
scheduler (the endpoint itself still exists for manual triggers - see below).
You can hit **Run workflow** in the Actions tab to trigger a scan manually at
any time.

### Verifying the scheduler

Every run opens a `running` row in `gems_scan_logs` the moment it starts,
then finalizes it to `success` / `partial` / `failed` when the scan finishes.
So Supabase tells you the truth about the schedule:

- Rows appearing every 3 hours = the scheduler is healthy.
- A `running` row stuck on `running` = the job was killed mid-scan (check
  the Actions log / `timeout-minutes`).
- No rows at all = the workflow never fired - check the Actions tab for
  scheduled runs and the secret values.
- A `failed` row with a message in `error` = the scan could not run at all.
  The `error` column names the cause - almost always one of:
  - `No discovery session configured` - `X_DISCOVERY_AUTH_TOKEN` /
    `X_DISCOVERY_CT0` are missing on the host (most common; the scan is
    separate from the numbered burners and must be configured everywhere the
    scan runs, not just in `.env.local`).
  - `X rejected the discovery session (401/403)` - the discovery burner's
    session expired; refresh both values from a logged-in browser.
  - `X rotated the search endpoint...` - the GraphQL query ID could not be
    rediscovered; the scan normally self-heals this, so it should be rare.
- A `partial` row with a message in `error` = some queries failed but the
  rest of the scan ran (`3 of 9 queries failed - ...`), or the storage write
  partly failed. The counts in the row are still accurate for what ran.
- All-zero `success` rows now mean the scan genuinely ran and found nothing -
  a quiet window, not a hidden failure. To sanity-check the pipeline locally:
  `node --env-file=.env.local scripts/diagnose-x-search.mjs` (one request on
  the discovery burner) prints which failure mode applies.

One-time migration: if you created the tables before this change, re-run
`supabase/schema.sql` - it widens the scan-logs `status` column to admit
`running` rows (idempotent, safe to re-run).

### Manual trigger (`/api/gems/run`)

The endpoint still exists for one-off manual scans: `GET
/api/gems/run?cron=<CRON_SECRET>` (or the `X-Cron-Secret` header). Note it
runs the scan inline and can take ~5 minutes - call it from a client that can
wait (e.g. `curl` on your own machine). If you call it through an edge that
caps response time (Cloudflare's ~100s proxy limit on free plans), you may
see an HTTP 524 even though the function keeps running server-side and
finalizes its log row - check `gems_scan_logs` rather than trusting the
HTTP response in that case. Other schedulers:
- **Vercel Cron (Hobby = once per day)** - free Vercel accounts only allow
  one cron invocation per day. Add a `vercel.json` with:
  ```json
  { "crons": [{ "path": "/api/gems/run?cron=${CRON_SECRET}", "schedule": "0 3 * * *" }] }
  ```
- **Self-hosted** - add a crontab line:
  ```
  0 */3 * * * curl -fsS "https://YOUR-HOST/api/gems/run?cron=YOUR_CRON_SECRET" -o /dev/null
  ```

### Scan budget

The defaults (`DISCOVERY_PAGES` 2, `DISCOVERY_MAX_CANDIDATES` 25,
`DISCOVERY_TIME_BUDGET_MS` 240000) are sized to fit inside Vercel's 300s
function cap for anyone running the endpoint route. The GitHub Actions job
**overrides them for full depth** - 3 pages per query, 50 candidates, a
25-minute wall-clock budget - since a VM has no such cap:

- `DISCOVERY_PAGES` (workflow: 3) - pages fetched per query
- `DISCOVERY_PAGE_SIZE` (default 50) - posts per page
- `DISCOVERY_MAX_CANDIDATES` (workflow: 50) - unique handles evaluated per run
- `DISCOVERY_MAX_FOLLOWERS` (default 1000) - follower ceiling
- `DISCOVERY_TIME_BUDGET_MS` (workflow: 1500000) - hard wall-clock cap on the
  scan so it always finishes and actually gets stored + logged. The 5s/request
  pacing on the discovery burner is unchanged (account health).

After each successful run the website updates automatically: `/api/gems`
reads the `added` projects straight from Supabase (lowest follower count
first), and the Alpha Terminal renders whatever is stored.

## Listing projects via the Telegram bot

The bot (`scripts/telegram-bot.ts`) is the manual listing path: the site only
shows projects that were either found by the scan or listed through the bot
and stored in Supabase. A listing never touches the discovery scan - it has
its own Groq + X (discovery burner) usage, paced like everything else on that
account.

Flow: paste a project link / tweet / text -> Groq extracts project name,
task, campaign details, and steps -> **Edit | List | Cancel** inline buttons
(edit task / details / steps, max 6 steps, editing stays available until you
list or cancel) -> List asks for the project's X handle and fetches its PFP
-> final preview -> **List** inserts the row into its own `projects` table
(separate from the NFT scan's `nft_projects` - these are curated campaigns,
not scan results) with status `listed` (so it appears on the site
immediately) and replies *Listed successfully.*

Run it:

```bash
npx tsx --env-file=.env.local scripts/telegram-bot.ts
```

Needs `TELEGRAM_BOT_TOKEN`, `GROQ_API_KEY` (or `TELEGRAM_GROQ_API_KEY`),
`X_DISCOVERY_AUTH_TOKEN` / `X_DISCOVERY_CT0` (tweet + PFP lookups), and
`NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (the insert writes
directly from the bot process). In-flight drafts persist to
`.telegram-bot-state.json` (gitignored) so a restart doesn't lose them.

One-time migration: re-run `supabase/schema.sql` - it creates the `projects`
table (idempotent, safe to re-run) where bot listings are stored.

## How it works

- **Proof of Work** (`/api/impressions`) - searches X for a user's posts
  mentioning a project and sums their view counts into a cumulative growth
  series, rendered as a shareable card (PNG export included).
- **Discovery scan** (`src/lib/x/discovery.ts`) - runs fixed high-intent
  queries for pre-mint NFT launches, dedupes candidate handles, hard-gates on
  follower count (< 1,000), rejects accounts already minting (regex + OpenSea
  check + Groq), and classifies the rest with Groq.
- **Burners** (`src/lib/x/accounts.ts`) - three user-facing burners at
  1 req/sec, plus a dedicated discovery burner at 5 req/sec so scans never
  compete with real users' requests.
