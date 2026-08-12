"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { downloadBlob, renderCardPng } from "@/lib/cardImage";
import { sparklinePoints, type Point } from "@/lib/sparkline";

export type Profile = {
  name: string;
  screen_name: string;
  avatar: string;
  followers: number;
  verified: boolean;
};

export type { Point };

type Props = {
  profile: Profile;
  project: string;
  projectProfile: Profile | null;
  impressions: number;
  postCount: number;
  series: Point[];
};

const BLUE = "#1E2AEB";

/** Cumulative growth as an area sparkline. One series, so no legend - the
 *  headline number above it names what is being plotted. */
function Sparkline({ series }: { series: Point[] }) {
  const width = 376;
  const height = 72;

  if (series.length < 2) {
    return <div className="h-[72px]" />;
  }

  const dot = 3;
  const { points, right } = sparklinePoints(series, width, height, dot);

  const line = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${right},${height} L0,${height} Z`;
  const [lastX, lastY] = points[points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="proof-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={BLUE} stopOpacity="0.18" />
          <stop offset="100%" stopColor={BLUE} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#proof-fill)" />
      <path
        d={line}
        fill="none"
        stroke={BLUE}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {/* Anchor the eye to the latest value */}
      <circle cx={lastX} cy={lastY} r={dot} fill={BLUE} />
    </svg>
  );
}

export default function ProofCard({
  profile,
  project,
  projectProfile,
  impressions,
  postCount,
  series,
}: Props) {
  const handle = profile.screen_name || profile.name;
  const cardRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const range =
    series.length > 1
      ? `${formatDate(series[0].t)} - ${formatDate(series[series.length - 1].t)}`
      : "";

  async function download() {
    setSaving(true);
    try {
      const blob = await renderCardPng({
        name: profile.name || handle,
        handle,
        avatar: profile.avatar,
        projectAvatar: projectProfile?.avatar ?? null,
        project,
        impressions,
        postCount,
        series,
        // Match whatever the page actually resolved, rather than guessing
        fontFamily: cardRef.current
          ? getComputedStyle(cardRef.current).fontFamily
          : "system-ui, sans-serif",
      });
      if (blob) downloadBlob(blob, `${handle}-${project}-proof.png`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="w-full">
      <div
        ref={cardRef}
        className="relative w-full overflow-hidden rounded-2xl bg-white"
      >
      <div className="flex flex-col gap-4 p-5 sm:gap-5 sm:p-6">
        {/* identity + what this is proof of */}
        <div className="flex items-center gap-3">
          {profile.avatar ? (
            <Image
              src={profile.avatar}
              alt=""
              width={40}
              height={40}
              className="h-10 w-10 shrink-0 rounded-full object-cover"
            />
          ) : (
            <div className="h-10 w-10 shrink-0 rounded-full bg-black/10" />
          )}

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-[#111]">
              {profile.name || handle}
            </p>
            <p className="truncate text-xs text-black/50">@{handle}</p>
          </div>

          {/* the project this is proof of, as its own mark */}
          {projectProfile?.avatar ? (
            <Image
              src={projectProfile.avatar}
              alt={projectProfile.name || project}
              title={`proof of ${projectProfile.name || project}`}
              width={32}
              height={32}
              className="h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-black/10"
            />
          ) : (
            <span
              className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold"
              style={{ backgroundColor: `${BLUE}14`, color: BLUE }}
            >
              {project}
            </span>
          )}
        </div>

        {/* the headline */}
        <div>
          <p className="text-[38px] font-semibold leading-none tracking-tight text-[#111] tabular-nums sm:text-[44px]">
            {impressions.toLocaleString()}
          </p>
          <p className="mt-1.5 text-xs text-black/50">
            impressions across {postCount} {postCount === 1 ? "post" : "posts"}
          </p>
        </div>
      </div>

        {/* growth, flush to the card edges */}
        <Sparkline series={series} />

        {range && (
          <p className="px-5 pb-4 pt-2 text-[11px] text-black/40 sm:px-6">{range}</p>
        )}

        {/* Drawn in the DOM only - the PNG is rendered from data, so this
            never appears in the exported image */}
        <button
          type="button"
          onClick={download}
          disabled={saving}
          aria-label="Download as PNG"
          title="Download PNG"
          className="absolute bottom-3 right-3 flex h-8 w-8 items-center justify-center rounded-lg text-black/35 outline-none transition-colors hover:bg-black/5 hover:text-black/70 disabled:opacity-40"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`h-[15px] w-[15px] ${saving ? "animate-pulse" : ""}`}
            aria-hidden="true"
          >
            <path d="M12 4v11" />
            <path d="m7.5 11 4.5 4.5 4.5-4.5" />
            <path d="M5 20h14" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}
