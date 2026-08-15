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
    return <p className="text-sm font-medium text-white/80">Scanning for gems...</p>;
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

  return (
    <div className="flex h-full w-full max-w-md flex-col overflow-hidden py-4 sm:py-6">
      <div className="flex flex-col motion-reduce:[animation:none] hover:[animation-play-state:paused] [animation:marquee-up_45s_linear_infinite]">
        {copy(false)}
        {copy(true)}
      </div>
    </div>
  );
}
