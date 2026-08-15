"use client";

import { useState } from "react";
import GemsFeed from "./GemsFeed";
import ProofOfWork from "./ProofOfWork";
import Sidebar, { type TabId } from "./Sidebar";

export default function App() {
  const [tab, setTab] = useState<TabId>("proof");

  return (
    <>
      <Sidebar active={tab} onChange={setTab} />

      {/* padding clears the sidebar: bottom bar on mobile, rail on desktop */}
      <main className="flex h-full w-full items-center justify-center px-3 pb-28 sm:px-6 sm:pb-0 sm:pl-24">
        {tab === "proof" ? (
          <ProofOfWork />
        ) : tab === "terminal" ? (
          <GemsFeed />
        ) : (
          <p className="text-sm font-medium text-white/80">Coming Soon.</p>
        )}
      </main>
    </>
  );
}
