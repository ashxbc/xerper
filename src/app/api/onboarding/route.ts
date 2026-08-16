import { NextResponse } from "next/server";
import { isSupabaseConfigured, serverClient } from "@/lib/supabase";

export const runtime = "nodejs";
// Every event is a write - never serve a cached response.
export const dynamic = "force-dynamic";

/** Steps of the first-visit follow flow, each of which stamps its own column. */
const EVENTS = [
  "shown", // modal displayed to the visitor
  "follow_clicked", // visitor clicked "Follow great Valor"
  "detection_completed", // the 5-second detection state finished
  "continue", // visitor clicked Continue - flow completed
] as const;

type Event = (typeof EVENTS)[number];

function columnFor(event: Event): string {
  switch (event) {
    case "shown":
      return "modal_shown_at";
    case "follow_clicked":
      return "follow_clicked_at";
    case "detection_completed":
      return "detection_completed_at";
    case "continue":
      return "continue_clicked_at";
  }
}

/** Record one step of the first-visit onboarding flow. The client sends its
 *  session id + event (fire-and-forget); the row is upserted by session_id so
 *  the funnel accumulates timestamps instead of creating a row per event.
 *  Degrades gracefully (no-op) before Supabase is configured. */
export async function POST(request: Request) {
  let body: { session_id?: unknown; event?: unknown; metadata?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const sessionId = String(body.session_id ?? "").trim().slice(0, 100);
  const event = String(body.event ?? "") as Event;
  if (!sessionId) {
    return NextResponse.json({ ok: false, error: "session_id is required" }, { status: 400 });
  }
  if (!EVENTS.includes(event)) {
    return NextResponse.json({ ok: false, error: "Unknown event" }, { status: 400 });
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: true, logged: false });
  }

  const now = new Date().toISOString();
  const column = columnFor(event);
  const metadata =
    body.metadata && typeof body.metadata === "object"
      ? (body.metadata as Record<string, unknown>)
      : {};

  try {
    const db = serverClient();
    const { data: existing } = await db
      .from("onboarding")
      .select("id")
      .eq("session_id", sessionId)
      .maybeSingle();

    if (existing) {
      await db
        .from("onboarding")
        .update({ [column]: now, updated_at: now })
        .eq("id", existing.id);
    } else {
      await db.from("onboarding").insert({
        session_id: sessionId,
        first_visit_at: now,
        [column]: now,
        metadata,
      });
    }
    return NextResponse.json({ ok: true, logged: true });
  } catch (error) {
    console.error(
      "[onboarding] failed to log event:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({ ok: true, logged: false });
  }
}
