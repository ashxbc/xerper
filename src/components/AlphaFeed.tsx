"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

// Shape served by /api/projects (src/lib/projects-store.ts) - one row per
// project listed through the Telegram bot. No mock data here.
type ListedProject = {
  handle: string;
  name: string;
  avatar: string;
  banner: string;
  bio: string;
  followers: number;
  following: number;
  verified: boolean;
  joined: string;
  task: string;
  details: string;
  steps: string[];
  prize_pool: string;
  campaign_url: string;
};

type FetchState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; projects: ListedProject[] };

type ProjectsResponse =
  | { ok: true; projects: ListedProject[] }
  | { ok: false; error: string };

// React Strict Mode mounts client components twice in development. Keep one
// module-level request so that behavior cannot double-fetch.
let projectsRequest: Promise<ListedProject[]> | null = null;

function fetchProjects(): Promise<ListedProject[]> {
  if (projectsRequest) return projectsRequest;

  projectsRequest = fetch("/api/projects")
    .then(async (response) => {
      const data = (await response.json()) as ProjectsResponse;
      if (!response.ok || !data.ok) throw new Error("Projects request failed");
      return data.projects;
    })
    .catch((error) => {
      // Permit a later retry after a real failure.
      projectsRequest = null;
      throw error;
    });

  return projectsRequest;
}

/** Coin with a dollar sign - the exact paths from the project's chosen SVG
 *  (coin-svgrepo-com), drawn with currentColor so it inherits the brand
 *  blue wherever it is placed. */
function CoinIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="-0.5 0 25 25"
      aria-hidden="true"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M12 22.9199C17.5228 22.9199 22 18.4428 22 12.9199C22 7.39707 17.5228 2.91992 12 2.91992C6.47715 2.91992 2 7.39707 2 12.9199C2 18.4428 6.47715 22.9199 12 22.9199Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.7002 17.1099V18.21C12.7002 18.3877 12.6296 18.5582 12.504 18.6838C12.3783 18.8095 12.2079 18.8799 12.0302 18.8799C11.8525 18.8799 11.6821 18.8095 11.5565 18.6838C11.4308 18.5582 11.3602 18.3877 11.3602 18.21V17.0801C10.9165 17.0072 10.4917 16.8468 10.1106 16.6082C9.72943 16.3695 9.39958 16.0573 9.14023 15.6899C9.04577 15.57 8.99311 15.4226 8.99023 15.27C8.99014 15.1834 9.00762 15.0975 9.04164 15.0178C9.07566 14.9382 9.12551 14.8662 9.18816 14.8064C9.2508 14.7466 9.32494 14.7 9.40608 14.6697C9.48723 14.6393 9.5737 14.6258 9.66023 14.6299C9.74611 14.6294 9.83102 14.648 9.90884 14.6843C9.98667 14.7206 10.0554 14.774 10.1102 14.8401C10.4301 15.258 10.8643 15.574 11.3602 15.75V13.21C10.0302 12.69 9.36023 11.9099 9.36023 10.8999C9.38027 10.3592 9.59279 9.84343 9.95949 9.44556C10.3262 9.04769 10.8229 8.79397 11.3602 8.72998V7.62988C11.3602 7.45219 11.4308 7.2819 11.5565 7.15625C11.6821 7.0306 11.8525 6.95996 12.0302 6.95996C12.2079 6.95996 12.3783 7.0306 12.504 7.15625C12.6296 7.2819 12.7002 7.45219 12.7002 7.62988V8.71997C13.0723 8.77828 13.4289 8.91103 13.7485 9.11035C14.0681 9.30967 14.3442 9.57137 14.5602 9.87988C14.6555 9.99235 14.7117 10.1329 14.7202 10.28C14.7229 10.3657 14.7083 10.451 14.6774 10.531C14.6464 10.611 14.5997 10.684 14.54 10.7456C14.4803 10.8072 14.4088 10.856 14.3298 10.8894C14.2509 10.9228 14.166 10.94 14.0802 10.9399C13.9906 10.9394 13.9022 10.9196 13.8211 10.8816C13.74 10.8436 13.668 10.7884 13.6102 10.72C13.3718 10.4221 13.0574 10.1942 12.7002 10.0601V12.3101L12.9502 12.4099C14.2202 12.9099 15.0102 13.63 15.0102 14.77C14.9954 15.3808 14.7481 15.9629 14.3189 16.3977C13.8897 16.8325 13.3108 17.0871 12.7002 17.1099ZM11.3602 11.73V10.0999C11.1988 10.1584 11.0599 10.2662 10.963 10.408C10.8662 10.5497 10.8162 10.7183 10.8202 10.8899C10.8185 11.0673 10.8688 11.2414 10.9647 11.3906C11.0607 11.5399 11.1981 11.6579 11.3602 11.73ZM13.5502 14.8C13.5502 14.32 13.2202 14.03 12.7002 13.8V15.8C12.9387 15.7639 13.156 15.6427 13.3122 15.459C13.4684 15.2752 13.553 15.0412 13.5502 14.8Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Chain-link icon for the campaign link button. */
function LinkIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function ProjectCard({
  project,
  onOpen,
}: {
  project: ListedProject;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`Open details for ${project.name}`}
      className="group w-64 overflow-hidden rounded-2xl text-left shadow-lg ring-1 ring-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:ring-[#1E2AEB]/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1E2AEB] focus-visible:ring-offset-2"
      style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
    >
      {/* Surface - same white + hairline language as the X profile cards */}
      <div className="border border-[#eff3f4] bg-white text-[#0f1419]">
        {/* Identity row: avatar left, name + handle stacked beside it. */}
        <div className="flex items-center gap-3 px-4 pb-3 pt-4">
          <div className="h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-[#eff3f4] ring-1 ring-black/5">
            {project.avatar ? (
              <Image
                src={project.avatar}
                alt=""
                width={44}
                height={44}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="h-full w-full bg-[#eff3f4]" />
            )}
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-extrabold leading-5">
              {project.name || project.handle}
            </h2>
            <p className="truncate pt-0.5 text-[12px] leading-4 text-[#536471]">
              @{project.handle}
            </p>
          </div>
        </div>

        {/* The campaign task, clamped to two lines. */}
        <p className="line-clamp-2 min-h-8 px-4 pb-3 text-[12px] leading-4 text-[#536471]">
          {project.task}
        </p>

        {/* Prize row: hairline divider, then the amount - evenly padded. */}
        <div className="flex items-center gap-1.5 border-t border-[#eff3f4] px-4 pb-4 pt-3 text-[12px] leading-4 text-[#536471]">
          <CoinIcon className="h-3.5 w-3.5 shrink-0 text-[#1E2AEB]" />
          <span className="min-w-0">
            Prize pool:{" "}
            <strong className="font-bold text-[#0f1419]">
              {project.prize_pool || "Not stated"}
            </strong>
          </span>
        </div>
      </div>
    </button>
  );
}

export default function AlphaFeed() {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [selected, setSelected] = useState<ListedProject | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const projects = await fetchProjects();
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

  // Close the modal with Escape, and lock body scroll while it's open.
  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [selected]);

  // Loading - the same crescent-moon-eye spinner the other tabs use.
  if (state.status === "loading") {
    return (
      <svg
        viewBox="0 0 48 48"
        className="h-12 w-12 animate-spin"
        style={{ animationDuration: "1.6s" }}
        fill="white"
        aria-label="Loading"
        role="img"
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

  if (state.status === "error") {
    return <p className="text-sm font-medium text-white/80">Try again later.</p>;
  }

  if (state.projects.length === 0) {
    return (
      <p className="text-sm font-medium text-white/80">
        No projects yet.
      </p>
    );
  }

  return (
    <>
      {/* Cards flow left to right in a 4-column grid that wraps into rows
          going down - the column grows vertically as more projects are
          listed. A spacer above keeps the grid slightly down the viewport;
          normal flow, so the sidebar stays untouched. */}
      <div className="flex h-full w-full flex-col overflow-y-auto">
        <div className="h-[15%] shrink-0" aria-hidden="true" />
        <div className="grid w-full grid-cols-1 justify-items-start gap-4 pl-6 pr-6 min-[480px]:grid-cols-2 xl:grid-cols-4">
          {state.projects.map((project) => (
            <ProjectCard
              key={project.handle}
              project={project}
              onOpen={() => setSelected(project)}
            />
          ))}
        </div>
      </div>

      {/* Centered modal with the full campaign details */}
      {selected && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${selected.name} details`}
          onClick={() => setSelected(null)}
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4"
        >
          {/* Capped to the viewport on small screens - the body scrolls
              internally while the header and footer stay put. */}
          <div
            onClick={(event) => event.stopPropagation()}
            className="flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5"
            style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
          >
            {/* Header: avatar + identity + prize pool */}
            <div className="flex shrink-0 items-center gap-3 border-b border-[#eff3f4] px-5 py-4">
              <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl bg-[#eff3f4] ring-1 ring-black/5">
                {selected.avatar ? (
                  <Image
                    src={selected.avatar}
                    alt=""
                    width={48}
                    height={48}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="h-full w-full bg-[#eff3f4]" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-[16px] font-extrabold leading-5 text-[#0f1419]">
                  {selected.name || selected.handle}
                </h2>
                <p className="text-[13px] leading-4 text-[#536471]">
                  @{selected.handle}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-[11px] uppercase tracking-wide text-[#536471]">
                  Prize pool
                </p>
                <p className="flex items-center justify-end gap-1 text-[15px] font-extrabold text-[#1E2AEB]">
                  <CoinIcon className="h-4 w-4 text-[#1E2AEB]" />
                  {selected.prize_pool || "Not stated"}
                </p>
              </div>
            </div>

            {/* Body: what the campaign is + steps to perform - scrolls when
                the content is taller than the viewport. */}
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
              <div>
                <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wide text-[#536471]">
                  Task
                </h3>
                <p className="text-[13px] leading-relaxed text-[#0f1419]">
                  {selected.task}
                </p>
              </div>
              <div>
                <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wide text-[#536471]">
                  About the campaign
                </h3>
                <p className="text-[13px] leading-relaxed text-[#0f1419]">
                  {selected.details}
                </p>
              </div>
              <div>
                <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-[#536471]">
                  Steps to perform
                </h3>
                <ol className="space-y-2">
                  {selected.steps.map((step, index) => (
                    <li key={`${step}-${index}`} className="flex items-start gap-2.5">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#1E2AEB] text-[10px] font-bold text-white">
                        {index + 1}
                      </span>
                      <span className="text-[13px] leading-snug text-[#0f1419]">
                        {step}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>

            {/* Footer: campaign link at bottom-left, Close at bottom-right */}
            <div className="flex shrink-0 items-center justify-between border-t border-[#eff3f4] px-5 py-3">
              {selected.campaign_url ? (
                <a
                  href={selected.campaign_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open campaign link"
                  title={selected.campaign_url}
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-[#536471] transition-colors hover:bg-[#1E2AEB]/10 hover:text-[#1E2AEB] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1E2AEB]"
                >
                  <LinkIcon className="h-4.5 w-4.5" />
                </a>
              ) : (
                <span aria-hidden="true" />
              )}
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-lg bg-[#1E2AEB] px-4 py-1.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1E2AEB] focus-visible:ring-offset-2"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
