import { NextResponse } from "next/server";
import { isSupabaseConfigured, listProjects } from "@/lib/projects-store";

export const runtime = "nodejs";
// Reads come straight from Supabase - nothing to cache at the route level.
export const dynamic = "force-dynamic";

/** Read-only feed for the Alpha Feed tab. Backed by the projects table in
 *  Supabase, which the Telegram bot keeps up to date - a project appears here
 *  the moment it is listed (status 'listed'). Before Supabase is configured,
 *  returns an empty list so the UI renders its empty state. */
export async function GET() {
  try {
    const projects = isSupabaseConfigured() ? await listProjects() : [];
    return NextResponse.json({ ok: true, projects });
  } catch (error) {
    console.error("[projects]", error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: "Try again later." }, { status: 502 });
  }
}
