/**
 * Runs the NFT-discovery scan outside the serverless HTTP layer and persists
 * the results to Supabase.
 *
 * Used by the GitHub Actions scheduler (.github/workflows/gems-scan.yml). The
 * scan talks straight to X on the dedicated discovery burner, classifies
 * candidates with Groq, and writes verdicts + a scan-log row to Supabase -
 * no HTTP endpoint in between. That matters because a full scan takes 4-10
 * minutes at the conservative 5s/request pacing, and a multi-minute scan
 * cannot reliably finish inside an HTTP request on the free tier: edges in
 * front of Vercel (e.g. Cloudflare's ~100s proxy cap) return 524, and the
 * function itself is capped at 300s. A GitHub Actions VM has neither limit.
 *
 * Requires env vars (set as workflow secrets, or in .env.local locally):
 *   X_DISCOVERY_AUTH_TOKEN / X_DISCOVERY_CT0  dedicated discovery burner
 *   GROQ_API_KEY                              candidate classifier
 *   NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  storage
 *
 * Optional budget overrides (defaults are sized for Vercel's 300s function
 * cap; on a VM, raise them - the workflow sets 3 pages / 50 candidates /
 * 25 minutes):
 *   DISCOVERY_PAGES, DISCOVERY_PAGE_SIZE, DISCOVERY_MAX_CANDIDATES,
 *   DISCOVERY_MAX_FOLLOWERS, DISCOVERY_TIME_BUDGET_MS
 *
 * Local run: npx tsx --env-file=.env.local scripts/run-scan.ts
 * Exit code is 0 on a fully successful run, 1 on any failure.
 */
import {
  insertScanLog,
  isSupabaseConfigured,
  updateScanLog,
} from "../src/lib/gems-store";
import { runDiscovery } from "../src/lib/x/discovery";

async function main(): Promise<void> {
  if (!isSupabaseConfigured()) {
    throw new Error(
      "Supabase is not configured - set NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY so results can be stored",
    );
  }

  // Open a 'running' scan-log row the moment the run starts, so even a run
  // killed mid-scan leaves a trace in gems_scan_logs. runDiscovery finalizes
  // it (via persistScanRun) when the scan completes.
  let logId: number | null = null;
  try {
    logId = await insertScanLog({ status: "running" });
  } catch (error) {
    console.error(
      "[run-scan] failed to open scan log:",
      error instanceof Error ? error.message : error,
    );
  }

  try {
    const result = await runDiscovery({
      force: true,
      persist: true,
      logId: logId ?? undefined,
    });

    if (result.persistence?.error) {
      console.error("[run-scan] storage error:", result.persistence.error);
      process.exitCode = 1;
    }

    console.log(
      `[run-scan] queries ${result.queries_run}/${result.queries_total} ` +
        `(skipped ${result.queries_skipped}), ${result.posts_scanned} posts, ` +
        `${result.candidates_considered} candidates considered, ` +
        `${result.projects.length} found, ${result.rejected.length} rejected, ` +
        `${result.persistence?.projects_new ?? 0} new, ` +
        `${result.persistence?.projects_skipped_duplicates ?? 0} duplicates, ` +
        `rate_limited=${result.rate_limited}` +
        (result.queries_skipped > 0
          ? `, first query error: ${result.queries_error ?? "unknown"}`
          : ""),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[run-scan] scan failed:", message);
    if (logId) {
      await updateScanLog(logId, {
        finished_at: new Date().toISOString(),
        status: "failed",
        projects_found: 0,
        projects_new: 0,
        projects_skipped_duplicates: 0,
        projects_rejected: 0,
        candidates_considered: 0,
        queries_run: 0,
        posts_scanned: 0,
        rate_limited: false,
        error: message.slice(0, 2000),
      }).catch(() => {
        // The original error is the real story.
      });
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(
    "[run-scan] fatal:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
