import { NextResponse } from "next/server";
import { isSupabaseConfigured, listAddedProjects } from "@/lib/gems-store";
import { runDiscovery } from "@/lib/x/discovery";

export const runtime = "nodejs";
// Reads come straight from Supabase - nothing to cache at the route level.
// (The fallback path below serves the in-memory scan result, which
// discovery.ts already caches itself.)
export const dynamic = "force-dynamic";
export const maxDuration = 900;

/** Read-only feed for the Alpha Terminal (diamond) tab. Backed by the
 *  nft_projects table in Supabase, which the scheduled scan (api/gems/run)
 *  keeps up to date every three hours - so new gems appear here automatically
 *  with no manual step. Before Supabase is configured, falls back to the
 *  in-memory discovery scan so the app still works during setup. */
export async function GET() {
  try {
    if (isSupabaseConfigured()) {
      const projects = await listAddedProjects();
      return NextResponse.json({ ok: true, projects });
    }

    // Pre-Supabase fallback: serve the cached scan.
    const result = await runDiscovery();
    if (result.rate_limited && result.projects.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Try again later." },
        { status: 429 },
      );
    }
    return NextResponse.json({ ok: true, projects: result.projects });
  } catch (error) {
    console.error("[gems]", error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: "Try again later." }, { status: 502 });
  }
}
