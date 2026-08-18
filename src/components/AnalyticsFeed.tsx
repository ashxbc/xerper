"use client";

import { useState, useRef, useEffect } from "react";
import Image from "next/image";

type DailyRow = {
  tweet_date: string;
  tweet_count: number;
  reply_count: number;
  total_impressions: number;
};

type Metric = "impressions" | "posts" | "replies";

type Profile = {
  name: string;
  handle: string;
  avatar: string;
  followers: number;
  following: number;
  verified: boolean;
  bio: string;
  joined: string;
};

type Range = "weekly" | "monthly";

type PeriodStats = {
  impressions: number;
  engagements: number;
  likes: number;
  replies: number;
  reposts: number;
  engagement_rate: number;
};

type Stats = {
  weekly: PeriodStats;
  monthly: PeriodStats;
};

const BLUE = "#1E2AEB";
const METRIC_VALUES: Record<Metric, string> = {
  impressions: "impressions",
  posts: "posts",
  replies: "replies",
};

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toLocaleString();
}

function formatRate(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0%";
  // Match X's display: whole percent when >= 1, one decimal below that.
  return n >= 1 ? `${Math.round(n)}%` : `${n.toFixed(1)}%`;
}

function formatDateShort(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function impressionValue(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

/** YYYY-MM-DD for a date offset from today (0 = today, negative = past). */
function dateOffsetStr(daysBack: number): string {
  const d = new Date();
  // Supabase `date` values and the API's date helpers are UTC calendar dates.
  // Using local midnight here can shift a bucket across midnight for users in
  // time zones east/west of UTC.
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

/** Weekly view: exactly the past 7 days ending today, one bar per calendar
 *  day, oldest first. Days with no stored data render as zero. */
function toWeekly(daily: DailyRow[]): DailyRow[] {
  const byDate = new Map(
    daily.map((d) => [d.tweet_date.slice(0, 10), d]),
  );
  return Array.from({ length: 7 }, (_, i) => {
    const daysBack = 6 - i;
    const tweet_date = dateOffsetStr(daysBack);
    const hit = byDate.get(tweet_date);
    return {
      tweet_date,
      tweet_count: impressionValue(hit?.tweet_count),
      reply_count: impressionValue(hit?.reply_count),
      total_impressions: impressionValue(hit?.total_impressions),
    };
  });
}

/** Monthly view: the past month as 4 weekly periods, one bar per week,
 *  oldest first. Each bar is the sum of its 7 calendar days; weeks with no
 *  stored data render as zero. Periods end today: [today-27..today-21],
 *  [today-20..today-14], [today-13..today-7], [today-6..today]. */
function toMonthly(daily: DailyRow[]): DailyRow[] {
  const byDate = new Map(
    daily.map((d) => [d.tweet_date.slice(0, 10), d]),
  );
  return Array.from({ length: 4 }, (_, i) => {
    const periodStart = 27 - i * 7;
    let totalImpressions = 0;
    let totalPosts = 0;
    let totalReplies = 0;
    for (let offset = 0; offset < 7; offset++) {
      const hit = byDate.get(dateOffsetStr(periodStart - offset));
      if (hit) {
        totalImpressions += impressionValue(hit.total_impressions);
        totalPosts += impressionValue(hit.tweet_count);
        totalReplies += impressionValue(hit.reply_count);
      }
    }
    return {
      tweet_date: dateOffsetStr(periodStart),
      tweet_count: totalPosts,
      reply_count: totalReplies,
      total_impressions: totalImpressions,
    };
  });
}

/** Pick a clean tick interval that gives ~4-5 horizontal grid lines. */
function niceTickStep(max: number): number {
  if (max <= 0) return 1;
  const rough = max / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / mag;
  let nice: number;
  if (normalized <= 1) nice = 1;
  else if (normalized <= 2) nice = 2;
  else if (normalized <= 5) nice = 5;
  else nice = 10;
  return nice * mag;
}

/** Extract the numeric value for the active metric from a DailyRow. */
function metricValue(row: DailyRow, metric: Metric): number {
  if (metric === "impressions") return row.total_impressions;
  if (metric === "posts") return row.tweet_count;
  return row.reply_count;
}

function BarChart({
  data,
  range,
  metric,
}: {
  data: DailyRow[];
  range: Range;
  metric: Metric;
}) {
  if (data.length === 0) {
    return (
      <div className="flex h-[220px] items-center justify-center text-sm text-black/40">
        No {METRIC_VALUES[metric]} data available.
      </div>
    );
  }

  const points = data.map((d) => ({
    ...d,
    value: Math.max(0, impressionValue(metricValue(d, metric))),
  }));
  const maxVal = Math.max(...points.map((d) => d.value), 0);
  const tickStep = niceTickStep(maxVal);
  const scaleMax = Math.max(maxVal, tickStep);
  const ticks: number[] = [];
  for (let i = 0; ; i += 1) {
    const tick = i * tickStep;
    ticks.push(tick);
    if (tick >= scaleMax) break;
  }
  const topTick = ticks[ticks.length - 1] || 1;

  return (
    <div className="flex h-[260px] w-full min-w-0 select-none">
      {/* Y-axis labels */}
      <div className="relative h-full w-10 shrink-0 pr-2 text-right text-[11px] text-black/40">
        <div className="absolute inset-x-0 top-1 bottom-7 flex flex-col-reverse justify-between">
          {ticks.map((t) => (
            <span key={t} className="tabular-nums">
              {formatNum(t)}
            </span>
          ))}
        </div>
      </div>

      {/* Chart area */}
      <div className="relative min-w-0 flex-1 border-l border-black/10">
        {/* The plot excludes the x-axis labels so bars, grid lines, and the
            scale all share exactly the same height coordinate system. */}
        <div className="absolute inset-x-0 top-1 bottom-7">
        {/* Grid lines */}
        {ticks.map((t) => (
          <div
            key={t}
            className="absolute left-0 right-0 border-t border-dashed border-black/10"
            style={{ bottom: `${(t / topTick) * 100}%` }}
          />
        ))}

        {/* Bars */}
        <div className="relative flex h-full items-end justify-around gap-1 px-2">
          {points.map((d) => {
            const heightPct = (d.value / topTick) * 100;
            return (
              <div
                key={d.tweet_date}
                className="relative flex h-full min-w-0 flex-1 flex-col items-center justify-end"
              >
                <div
                  className="group relative w-full max-w-[48px] rounded-t-sm transition-[height] duration-300"
                  style={{
                    height: `${heightPct}%`,
                    backgroundColor: BLUE,
                  }}
                >
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-[#111] px-2 py-1 text-[11px] text-white shadow group-hover:block">
                    {d.value.toLocaleString()} {METRIC_VALUES[metric]}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        </div>

        {/* X-axis labels */}
        <div className="absolute bottom-0 left-0 right-0 flex h-7 items-end justify-around gap-1 px-2 pb-1 text-[11px] text-black/40">
          {points.map((d) => {
            const label =
              range === "weekly"
                ? formatDateShort(d.tweet_date)
                : `W/O ${formatDateShort(d.tweet_date)}`;
            return (
              <span key={d.tweet_date} className="min-w-0 flex-1 truncate text-center">
                {label}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Custom pill-style metric dropdown matching the Weekly/Monthly buttons. */
function MetricDropdown({
  metric,
  onChange,
}: {
  metric: Metric;
  onChange: (m: Metric) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const label = metric === "impressions" ? "Impressions" : metric === "posts" ? "Posts" : "Replies";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-full bg-black/5 px-4 py-1.5 text-xs font-medium text-black/50 transition-colors hover:bg-black/10"
      >
        {label}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1.5 w-36 overflow-hidden rounded-xl border border-black/5 bg-white py-1">
          {(["impressions", "posts", "replies"] as Metric[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { onChange(m); setOpen(false); }}
              className={`flex w-full items-center px-3.5 py-2 text-xs font-medium transition-colors ${
                metric === m
                  ? "bg-[#1E2AEB] text-white"
                  : "text-black/60 hover:bg-black/5"
              }`}
            >
              {m === "impressions" ? "Impressions" : m === "posts" ? "Posts" : "Replies"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Small eye-spinner used for the loading card. */
function EyeSpinner() {
  return (
    <svg
      viewBox="0 0 48 48"
      className="h-12 w-12 animate-spin"
      style={{ animationDuration: "1.6s" }}
      fill={BLUE}
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

export default function AnalyticsFeed() {
  const [step, setStep] = useState<"input" | "loading" | "result">("input");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [range, setRange] = useState<Range>("weekly");
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsRange, setStatsRange] = useState<Range>("weekly");
  const [metric, setMetric] = useState<Metric>("impressions");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const entry = value.trim();
    if (!entry) return;

    setStep("loading");

    try {
      const res = await fetch("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: entry }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        setError(data.error || "Try again later.");
        setStep("input");
        return;
      }

      setProfile(data.profile);
      setDaily(data.daily ?? []);
      setStats(data.stats ?? null);
      setStep("result");
    } catch {
      setError("Try again later.");
      setStep("input");
    }
  }

  const chartData = range === "weekly" ? toWeekly(daily) : toMonthly(daily);
  const displayProfile = profile ?? {
    name: value || "",
    handle: value.replace(/^@/, ""),
    avatar: "",
    followers: 0,
    following: 0,
    verified: false,
    bio: "",
    joined: "",
  };

  return (
    <div className="flex w-full max-w-[520px] flex-col items-center">
      {/* Input step */}
      {step === "input" && (
        <form onSubmit={handleSubmit} className="w-full">
          <div className="relative w-full">
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              enterKeyHint="go"
              placeholder="Enter an X username"
              className="w-full rounded-full bg-white py-3.5 pl-5 pr-14 text-center font-medium text-[#111] placeholder-black/60 outline-none"
            />
            {value.trim() && (
              <button
                type="submit"
                aria-label="Continue"
                className="absolute right-1.5 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-[#1E2AEB] text-white outline-none transition-transform active:scale-95"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4"
                  aria-hidden="true"
                >
                  <path d="M5 12h14" />
                  <path d="m13 5 7 7-7 7" />
                </svg>
              </button>
            )}
          </div>
          {error && (
            <p className="mt-3 text-center text-sm font-medium text-red-500">
              {error}
            </p>
          )}
        </form>
      )}

      {/* Loading step — white card with eye spinner */}
      {step === "loading" && (
        <div className="flex h-[220px] w-full items-center justify-center rounded-2xl bg-white">
          <div className="flex flex-col items-center gap-3">
            <EyeSpinner />
            <p className="text-sm font-medium text-black/50">
              Fetching analytics…
            </p>
          </div>
        </div>
      )}

      {/* Result step — white card */}
      {step === "result" && (
        <div className="w-full rounded-2xl bg-white p-5 shadow-sm">
          {/* Header: profile + back button */}
          <div className="mb-4 flex items-center gap-3">
            {displayProfile.avatar ? (
              <Image
                src={displayProfile.avatar}
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
                {displayProfile.name}
              </p>
              <p className="truncate text-xs text-black/50">
                @{displayProfile.handle}
                {displayProfile.verified && (
                  <span className="ml-1 text-[#1DA1F2]">✓</span>
                )}
              </p>
            </div>
          </div>

          {/* Range toggle + metric dropdown */}
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {(["weekly", "monthly"] as Range[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${
                    range === r
                      ? "bg-[#1E2AEB] text-white"
                      : "bg-black/5 text-black/50 hover:bg-black/10"
                  }`}
                >
                  {r === "weekly" ? "Weekly" : "Monthly"}
                </button>
              ))}
              <MetricDropdown metric={metric} onChange={setMetric} />
            </div>
            <button
              type="button"
              onClick={() => setStatsOpen(true)}
              aria-label="Open analytics stats"
              className="shrink-0 rounded-full p-1 text-black/40 transition-colors hover:bg-black/5 hover:text-black/70"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </div>

          {/* Bar chart */}
          <BarChart data={chartData} range={range} metric={metric} />

        </div>
      )}

      {/* Stats modal - opens on top of the analytics card */}
      {step === "result" && statsOpen && (
        <StatsModal
          stats={stats}
          range={statsRange}
          onRangeChange={setStatsRange}
          onClose={() => setStatsOpen(false)}
        />
      )}
    </div>
  );
}

function StatsModal({
  stats,
  range,
  onRangeChange,
  onClose,
}: {
  stats: Stats | null;
  range: Range;
  onRangeChange: (r: Range) => void;
  onClose: () => void;
}) {
  const s = stats?.[range];
  const cards = [
    { label: "Total impressions", value: formatNum(s?.impressions ?? 0) },
    { label: "Engagement rate", value: formatRate(s?.engagement_rate ?? 0) },
    { label: "Engagements", value: formatNum(s?.engagements ?? 0) },
    { label: "Likes", value: formatNum(s?.likes ?? 0) },
    { label: "Replies", value: formatNum(s?.replies ?? 0) },
    { label: "Reposts", value: formatNum(s?.reposts ?? 0) },
  ];

  return (
    /* Mirror main's padding exactly (px-3, sm:px-6 + sm:pl-24 for the
       sidebar) so the flex centering lands on the analytics card behind
       the modal instead of the raw viewport center. */
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-3 sm:px-6 sm:pl-24"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with period switcher */}
        <div className="flex items-center justify-between gap-3 border-b border-[#eff3f4] px-5 py-4">
          <p className="text-sm font-bold text-[#111]">X Analytics</p>
          <div className="flex items-center gap-2">
            <div className="flex rounded-full bg-black/5 p-0.5">
              {(["weekly", "monthly"] as Range[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => onRangeChange(r)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    range === r
                      ? "bg-[#1E2AEB] text-white"
                      : "text-black/50 hover:text-black/70"
                  }`}
                >
                  {r === "weekly" ? "Weekly" : "Monthly"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close stats"
              className="flex h-7 w-7 items-center justify-center rounded-full text-black/40 transition-colors hover:bg-black/5 hover:text-black/70"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* 3x2 metric grid */}
        <div className="grid grid-cols-3 gap-2.5 p-5">
          {cards.map((c) => (
            <div
              key={c.label}
              className="flex min-h-[88px] flex-col justify-between rounded-xl bg-[#f7f9fa] px-3.5 py-3"
            >
              <p className="text-[11px] font-medium leading-4 text-black/50">
                {c.label}
              </p>
              <p className="text-lg font-bold tabular-nums text-[#111]">
                {c.value}
              </p>
            </div>
          ))}
        </div>        {!stats && (
          <p className="px-5 pb-5 text-xs text-black/40">
            Stats unavailable - run a fresh lookup to populate interaction
            data.
          </p>
        )}
      </div>
    </div>
  );
}
