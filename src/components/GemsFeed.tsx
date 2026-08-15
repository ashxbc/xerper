"use client";

import { useEffect, useState } from "react";
import XProfileCard, { type XProfile } from "./XProfileCard";

type FetchState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; projects: XProfile[] };

type GemsResponse =
  | { ok: true; projects: XProfile[] }
  | { ok: false; error: string };

// React Strict Mode mounts client components twice in development. Keep one
// module-level request so that behavior cannot launch duplicate discovery scans.
let gemsRequest: Promise<XProfile[]> | null = null;

function fetchGems(): Promise<XProfile[]> {
  if (gemsRequest) return gemsRequest;

  gemsRequest = fetch("/api/gems")
    .then(async (response) => {
      const data = (await response.json()) as GemsResponse;
      if (!response.ok || !data.ok) throw new Error("Gems request failed");
      return data.projects;
    })
    .catch((error) => {
      // Permit a later retry after a real failure.
      gemsRequest = null;
      throw error;
    });

  return gemsRequest;
}

export default function GemsFeed() {
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const projects = await fetchGems();
        if (!cancelled) setState({ status: "ready", projects });
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    // The same crescent-moon-eye spinner the proof-of-work card uses, white
    // on the blue page background.
    return (
      <svg
        viewBox="0 0 48 48"
        className="h-12 w-12 animate-spin"
        style={{ animationDuration: "1.6s" }}
        fill="white"
        aria-label="Loading"
        role="img"
      >
        {/* two crescent-moon eyes, mirrored across the centre */}
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

  if (state.status === "error") {
    return <p className="text-sm font-medium text-white/80">Try again later.</p>;
  }

  if (state.projects.length === 0) {
    return <p className="text-sm font-medium text-white/80">No gems found yet.</p>;
  }

  // The card wall drifts slowly upward and loops seamlessly: the list is
  // rendered twice as identical copies, and the track translates by exactly
  // one copy's height, so the loop has no visible seam. Pauses on hover;
  // disabled entirely for users who prefer reduced motion.
  const copy = (ariaHidden: boolean) => (
    <div className="flex flex-col gap-3 pb-3" aria-hidden={ariaHidden || undefined}>
      {state.projects.map((project) => (
        <XProfileCard key={project.handle} profile={project} />
      ))}
    </div>
  );

  // The marquee viewport sits below a fixed header strip, so cards are
  // clipped at its top edge and can never scroll into the logo / "powered by
  // valor" zone - the same way the bottom clears the menu bar (which the
  // main layout handles with its own padding).
  return (
    <div className="flex h-full w-full max-w-md flex-col">
      <div className="h-16 shrink-0 sm:h-20" aria-hidden="true" />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="flex flex-col motion-reduce:[animation:none] hover:[animation-play-state:paused] [animation:marquee-up_45s_linear_infinite]">
          {copy(false)}
          {copy(true)}
        </div>
      </div>
    </div>
  );
}
