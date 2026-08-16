"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import Image from "next/image";

/**
 * First-visit gate. The first time a visitor loads the site, the normal UI
 * (sidebar, main content, "powered by valor") is hidden - only the logo stays
 * visible - and a centered modal asks them to follow Valor:
 *
 *   1. initial: GIF + pitch + "Follow great Valor" button (opens
 *      https://x.com/valor0x in a new tab)
 *   2. detecting: when the visitor returns to this tab, ~5s of eye/loading
 *      animation
 *   3. done: "I don't know if you followed the great Valor, but there you
 *      go." + Continue button -> restores the full UI
 *
 * Completion is tracked in localStorage (once per browser), and every step is
 * logged to the Supabase `onboarding` table via /api/onboarding.
 *
 * The record is read with useSyncExternalStore (not an effect) so the gate
 * resolves during hydration - returning visitors never see a flash of the
 * modal, and the server snapshot keeps SSR/hydration consistent.
 */

const STORAGE_KEY = "valor_onboarding_v1";
const FOLLOW_URL = "https://x.com/valor0x";
// How long the "detecting" state lingers before revealing the result.
const DETECT_MS = 5000;

type GateState = "initial" | "detecting" | "done";

type GateRecord = {
  sessionId: string;
  firstVisitAt: string;
  followClickedAt: string | null;
  completedAt: string | null;
};

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createFreshRecord(): GateRecord {
  return {
    sessionId: randomId(),
    firstVisitAt: new Date().toISOString(),
    followClickedAt: null,
    completedAt: null,
  };
}

function readRecord(): GateRecord | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GateRecord;
    if (!parsed || typeof parsed.sessionId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---- external store (localStorage-backed, stable across snapshots) --------

let cachedRecord: GateRecord | null | undefined;

function getClientRecord(): GateRecord | null {
  if (cachedRecord === undefined) cachedRecord = readRecord();
  return cachedRecord;
}

function subscribeStorage(callback: () => void): () => void {
  // storage events fire in OTHER tabs - re-read so multi-tab stays in sync.
  const onStorage = () => {
    cachedRecord = undefined;
    callback();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/** The server can't read localStorage - hydration reconciles via the client
 *  snapshot immediately after, so returning visitors never see the gate. */
function getServerRecord(): GateRecord | null {
  return null;
}

function writeRecord(record: GateRecord): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage unavailable (private mode etc.) - the flow still works for this
    // visit, it just can't remember itself across reloads.
  }
  cachedRecord = record;
}

/** Fire-and-forget log of one onboarding step to the Supabase funnel. */
function logEvent(
  event: "shown" | "follow_clicked" | "detection_completed" | "continue",
  record: GateRecord,
): void {
  fetch("/api/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: record.sessionId,
      event,
      metadata: {
        user_agent: navigator.userAgent.slice(0, 300),
        screen: `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}`,
      },
    }),
  }).catch(() => {
    // Tracking is best-effort - never block the flow on it.
  });
}

/** The same crescent-moon-eye spinner the other tabs use - our loading icon. */
function EyeSpinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      className={`h-12 w-12 animate-spin ${className ?? ""}`}
      style={{ animationDuration: "1.6s" }}
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"
        transform="translate(41.6 6.4) scale(-0.8 0.8)"
      />
      <path
        d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"
        transform="translate(25.6 22.4) scale(-0.8 0.8)"
      />
    </svg>
  );
}

export default function FirstVisitGate({
  children,
  // Set server-side from the completion cookie - when true, the gate is
  // skipped entirely (children render in the initial HTML, no flash).
  serverCompleted = false,
}: {
  children: ReactNode;
  serverCompleted?: boolean;
}) {
  const record = useSyncExternalStore(
    subscribeStorage,
    getClientRecord,
    getServerRecord,
  );

  // Resume mid-flow sessions at the detection step (they clicked follow but
  // never finished). Initializer reads storage synchronously - fine.
  const [state, setState] = useState<GateState>(() => {
    const r = readRecord();
    return r && r.followClickedAt && !r.completedAt ? "detecting" : "initial";
  });
  // True once this visitor finishes the flow in this session.
  const [done, setDone] = useState(false);

  const completed = done || Boolean(record?.completedAt);

  // First-visit bookkeeping: create the session record and log the modal as
  // shown. Pure side effects - no setState, so the gate stays SSR-safe.
  useEffect(() => {
    if (serverCompleted) return;
    const existing = readRecord();
    if (existing?.completedAt) return;
    const active = existing ?? createFreshRecord();
    if (!existing) writeRecord(active);
    logEvent("shown", active);
  }, [serverCompleted]);

  // Detection state runs ~5 seconds, then reveals the result.
  useEffect(() => {
    if (state !== "detecting") return;
    const timer = setTimeout(() => {
      setState("done");
      const r = readRecord();
      if (r) logEvent("detection_completed", r);
    }, DETECT_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const handleFollow = () => {
    const base = record ?? readRecord() ?? createFreshRecord();
    // Treat the stored record as immutable - build a fresh object to write.
    const next: GateRecord = {
      ...base,
      followClickedAt: new Date().toISOString(),
    };
    writeRecord(next);
    logEvent("follow_clicked", next);

    // Start "detecting" as soon as the visitor returns to this tab. Covers
    // both tab switches back (visibilitychange) and window refocus (focus).
    const beginDetection = () => {
      window.removeEventListener("focus", beginDetection);
      document.removeEventListener("visibilitychange", beginDetection);
      setState("detecting");
    };
    window.addEventListener("focus", beginDetection);
    document.addEventListener("visibilitychange", beginDetection);

    const opened = window.open(FOLLOW_URL, "_blank", "noopener");
    if (!opened) {
      // Popup blocked - don't strand the visitor; fall back after a pause.
      setTimeout(beginDetection, 1500);
    }
  };

  const handleContinue = () => {
    const base = record ?? readRecord() ?? createFreshRecord();
    // Treat the stored record as immutable - build a fresh object to write.
    const next: GateRecord = {
      ...base,
      completedAt: new Date().toISOString(),
    };
    writeRecord(next);
    // Completion cookie - the server reads this on later visits and skips the
    // gate in the initial HTML, so returning users never see a flash of it.
    document.cookie =
      "valor_onboarding=1; path=/; max-age=31536000; samesite=lax";
    logEvent("continue", next);
    setDone(true);
  };

  // Completed visitors (server cookie or this session) see the site untouched.
  if (serverCompleted || completed) return <>{children}</>;

  return (
    <>
      {/* The only part of the normal UI that stays visible: the top-left logo. */}
      <Image
        src="/xerper.png"
        alt="Xerper"
        width={280}
        height={280}
        priority
        className="pointer-events-none absolute -left-2 -top-2 w-[60px] select-none sm:w-[80px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Follow Valor to continue"
        className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      >
        <div
          className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl bg-white text-center shadow-2xl ring-1 ring-black/5"
          style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
        >
          {state === "initial" && (
            <>
              {/* GIF cropped to a clean 16:9 strip that fills the modal's
                  width - the file itself is 498x280 (~16:9). */}
              <div className="aspect-video w-full overflow-hidden bg-black">
                {/* GIFs need a plain img - next/image serves static frames. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/valor-gate.gif"
                  alt=""
                  className="h-full w-full object-cover"
                />
              </div>                <div className="px-6 pb-6 pt-5">
                  <p className="text-[15px] font-extrabold leading-snug text-[#0f1419]">
                    Follow the best builder on planet Earth to continue.
                  </p>
                  <button
                  type="button"
                  onClick={handleFollow}
                  className="mt-5 w-full rounded-xl bg-[#1E2AEB] px-6 py-3 text-[15px] font-bold text-white transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1E2AEB] focus-visible:ring-offset-2"
                >
                  Follow the great Valor
                </button>
              </div>
            </>
          )}

          {state === "detecting" && (
            <div className="flex flex-col items-center px-6 py-12">
              <EyeSpinner className="h-14 w-14 text-[#1E2AEB]" />
              <p className="mt-5 text-[13px] font-semibold leading-relaxed text-[#536471]">
                Detecting whether you followed Valor…
              </p>
            </div>
          )}

          {state === "done" && (
            <div className="px-6 py-10">                <p className="text-[15px] font-extrabold leading-snug text-[#0f1419]">
                  I don&apos;t know if you followed, but there you go.
                </p>
              <button
                type="button"
                onClick={handleContinue}
                className="mt-6 w-full rounded-xl bg-[#1E2AEB] px-6 py-3 text-[15px] font-bold text-white transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1E2AEB] focus-visible:ring-offset-2"
              >
                Continue
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
