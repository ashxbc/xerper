import { NextResponse } from "next/server";
import { runDiscovery } from "@/lib/x/discovery";

export const runtime = "nodejs";
// Scans burn the dedicated discovery account's budget, so nothing here is
// cached at the route level - lib/x/discovery.ts caches the assembled
// result itself.
export const dynamic = "force-dynamic";
// Up to 50 candidates can each cost two X requests plus Groq, on top of the
// paginated searches. The dedicated account is intentionally paced at five
// seconds between requests to protect account health.
export const maxDuration = 900;

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
