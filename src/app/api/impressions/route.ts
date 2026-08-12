import { NextResponse } from "next/server";
import { fetchImpressions } from "@/lib/x/impressions";
import { AuthFailed } from "@/lib/x/search";

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

  try {
    return NextResponse.json(await fetchImpressions(username, project));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[impressions]", message);
    return NextResponse.json(
      { ok: false, error: message },
      { status: error instanceof AuthFailed ? 401 : 502 },
    );
  }
}
