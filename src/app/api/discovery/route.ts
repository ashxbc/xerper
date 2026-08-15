import { NextResponse } from "next/server";
import { runDiscovery } from "@/lib/x/discovery";

export const runtime = "nodejs";
// Scans burn the dedicated discovery account's budget, so nothing here is
// cached at the route level - lib/x/discovery.ts caches the assembled
// result itself.
export const dynamic = "force-dynamic";
// Vercel Hobby caps function duration at 300s; the scan budget
// (DISCOVERY_PAGES / DISCOVERY_MAX_CANDIDATES) defaults to fit inside that
// window. Raise both if you upgrade or self-host.
export const maxDuration = 300;

/** Backend-only discovery scan - not linked from the UI. If DISCOVERY_SECRET
 *  is set, callers must pass it via `?secret=` or the X-Discovery-Secret
 *  header; a mismatch returns 404 so the route doesn't announce itself. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const configured = (process.env.DISCOVERY_SECRET ?? "").trim();
  if (configured) {
    const provided =
      request.headers.get("x-discovery-secret") ?? searchParams.get("secret") ?? "";
    if (provided !== configured) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }
  }

  try {
    const result = await runDiscovery();
    return NextResponse.json(result);
  } catch (error) {
    console.error("[discovery]", error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: "Try again later." }, { status: 502 });
  }
}
