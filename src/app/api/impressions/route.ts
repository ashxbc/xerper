import { NextResponse } from "next/server";
import { fetchImpressions } from "@/lib/x/impressions";
import { AuthFailed, RateLimited } from "@/lib/x/search";

export const runtime = "nodejs";
// Every request hits X live, so nothing here should be cached
export const dynamic = "force-dynamic";
// Paging through a busy account takes longer than the 10s default
export const maxDuration = 60;

export async function POST(request: Request) {
  let username: string;
  let project: string;

  try {
    const body = await request.json();
    username = String(body.username ?? "").trim();
    project = String(body.project ?? "").trim();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!username || !project) {
    return NextResponse.json(
      { ok: false, error: "username and project are both required" },
      { status: 400 },
    );
  }

  // Same guard as the client: the card credits a user for their posts about a
  // project, so the project can never be the user's own account. Compare on
  // the raw handle (@User == user == USER) so the check can't be bypassed by
  // casing or a leading @.
  const norm = (s: string) => s.replace(/^@/, "").trim().toLowerCase();
  if (norm(username) === norm(project)) {
    return NextResponse.json(
      { ok: false, error: "Project name can't be your own username" },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await fetchImpressions(username, project));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[impressions]", message);
    const status = error instanceof AuthFailed
      ? 401
      : error instanceof RateLimited
        ? 429
        : 502;
    return NextResponse.json({ ok: false, error: "Try again later." }, { status });
  }
}
