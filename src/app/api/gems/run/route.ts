import { NextResponse } from "next/server";
import {
  insertScanLog,
  isSupabaseConfigured,
  updateScanLog,
} from "@/lib/gems-store";
import { runDiscovery } from "@/lib/x/discovery";

export const runtime = "nodejs";
// This endpoint is the scheduled scan itself - it must never serve a cached
// response, and it runs a fresh scan on every call.
export const dynamic = "force-dynamic";
// Vercel Hobby caps function duration at 300s; the scan budget
// (DISCOVERY_PAGES / DISCOVERY_MAX_CANDIDATES) defaults to fit inside that
// window. Raise both if you upgrade or self-host.
export const maxDuration = 300;

/** Scheduled Gems Finding scan. Not meant for browsers: a scheduler calls
 *  this every three hours (see the GitHub Actions workflow in .github/ - Vercel
 *  Hobby crons are limited to once per day - or the crontab line in the README).
 *
 *  If CRON_SECRET is set, callers must pass it via `?cron=` or the
 *  X-Cron-Secret header; a mismatch returns 404 so the route does not
 *  announce itself.
 *
 *  Runs a fresh scan (no cache), persists every verdict to the nft_projects
 *  table (new handles only - existing ones are skipped as duplicates), and
 *  records the run in gems_scan_logs. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const configured = (process.env.CRON_SECRET ?? "").trim();
  if (configured) {
    const provided =
      request.headers.get("x-cron-secret") ?? searchParams.get("cron") ?? "";
    if (provided !== configured) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Supabase is not configured - set NEXT_PUBLIC_SUPABASE_URL and " +
          "SUPABASE_SERVICE_ROLE_KEY so results can be stored",
      },
      { status: 500 },
    );
  }

  // Two-phase logging: open a 'running' row the moment the endpoint is hit so
  // every scheduled call leaves a trace in gems_scan_logs - even one killed
  // mid-scan - and persistScanRun finalizes it when the scan finishes.
  let logId: number | null = null;
  try {
    logId = await insertScanLog({ status: "running" });
  } catch (error) {
    console.error(
      "[gems/run] failed to open scan log:",
      error instanceof Error ? error.message : error,
    );
  }

  try {
    const result = await runDiscovery({ force: true, logId: logId ?? undefined });

    // The scan ran but storing it may have failed - that means any found
    // projects will not reach the site, so fail loudly instead of reporting
    // a cheerful 200. The scan-log row already carries the full counts.
    if (result.persistence?.error) {
      console.error("[gems/run]", result.persistence.error);
      return NextResponse.json(
        {
          ok: false,
          error: `Scan completed but storage failed: ${result.persistence.error}`,
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      generated_at: result.generated_at,
      rate_limited: result.rate_limited,
      // Full scan picture, so the scheduler's output shows what actually
      // happened - not just the four project counters.
      queries_run: result.queries_run,
      queries_skipped: result.queries_skipped,
      queries_total: result.queries_total,
      posts_scanned: result.posts_scanned,
      candidates_considered: result.candidates_considered,
      candidates_lookup_failed: result.candidates_lookup_failed,
      candidates_over_follower_limit: result.candidates_over_follower_limit,
      candidates_already_minting: result.candidates_already_minting,
      candidates_classification_failed:
        result.candidates_classification_failed,
      projects_found: result.projects.length,
      projects_new: result.persistence?.projects_new ?? 0,
      projects_skipped_duplicates:
        result.persistence?.projects_skipped_duplicates ?? 0,
      projects_rejected: result.rejected.length,
      log_inserted: result.persistence?.log_inserted ?? false,
      ...(result.queries_skipped > 0
        ? {
            warning: `Scan was partial: ${result.queries_skipped} of ${result.queries_total} queries failed`,
          }
        : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[gems/run]", message);

    // Finalize the open row (or record a standalone failure if opening it
    // failed) - every scheduled call is tracked, including failures.
    try {
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
        });
      } else {
        await insertScanLog({ status: "failed", error: message });
      }
    } catch {
      // Logging the failure failed - the original error is the real story.
    }
    return NextResponse.json({ ok: false, error: "Try again later." }, { status: 502 });
  }
}
