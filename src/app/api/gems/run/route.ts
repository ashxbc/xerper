import { NextResponse } from "next/server";
import { insertScanLog, isSupabaseConfigured } from "@/lib/gems-store";
import { runDiscovery } from "@/lib/x/discovery";

export const runtime = "nodejs";
// This endpoint is the scheduled scan itself - it must never serve a cached
// response, and it runs a fresh scan on every call.
export const dynamic = "force-dynamic";
// A cold run pages through every query and evaluates up to 50 candidates on
// the dedicated discovery account at five-second pacing - it can take most
// of the platform's max duration.
export const maxDuration = 900;

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

  try {
    const result = await runDiscovery({ force: true });

    // The scan ran but storing it may have failed - surface that so a
    // partially-persisted run is visible rather than silent.
    if (result.persistence?.error) {
      console.error("[gems/run]", result.persistence.error);
    }

    return NextResponse.json({
      ok: true,
      generated_at: result.generated_at,
      rate_limited: result.rate_limited,
      projects_found: result.projects.length,
      projects_new: result.persistence?.projects_new ?? 0,
      projects_skipped_duplicates:
        result.persistence?.projects_skipped_duplicates ?? 0,
      log_inserted: result.persistence?.log_inserted ?? false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[gems/run]", message);

    // Every scheduled call is tracked, including failures.
    await insertScanLog({ status: "failed", error: message }).catch(() => {});
    return NextResponse.json({ ok: false, error: "Try again later." }, { status: 502 });
  }
}
