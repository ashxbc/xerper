"use client";

import { useState } from "react";
import ProofCard, { type Point, type Profile } from "./ProofCard";

type Step = "username" | "loading" | "project" | "card";

type Result = {
  profile: Profile;
  project: string;
  projectProfile: Profile | null;
  impressions: number;
  postCount: number;
  series: Point[];
};

export default function ProofOfWork() {
  const [step, setStep] = useState<Step>("username");
  const [value, setValue] = useState("");
  const [username, setUsername] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");

  const isInput = step === "username" || step === "project";

  async function fetchImpressions(user: string, project: string) {
    setError("");
    setResult(null);

    try {
      const res = await fetch("/api/impressions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, project }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        setError("Try again later.");
        return;
      }

      setResult({
        profile: data.profile,
        project: data.project,
        projectProfile: data.project_profile ?? null,
        impressions: data.total_impressions ?? 0,
        postCount: data.post_count ?? 0,
        series: data.series ?? [],
      });
    } catch {
      setError("Try again later.");
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const entry = value.trim();
    if (!entry) return;

    if (step === "username") {
      setUsername(entry);
      setValue("");
      setStep("loading");
      // Brief pause before asking for the project
      setTimeout(() => setStep("project"), 900);
    } else if (step === "project") {
      setValue("");
      setStep("card");
      void fetchImpressions(username, entry);
    }
  }

  return (
    <div className="flex w-full max-w-[440px] flex-col items-center">
      {isInput && (
        <form onSubmit={handleSubmit} className="w-full">
          {step === "project" && username && (
            <p className="mb-3 text-center text-sm font-medium text-white">
              @{username.replace(/^@/, "")}
            </p>
          )}
          <input
            key={step}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              step === "username"
                ? "Enter your X username"
                : "Enter project name or X handle"
            }
            className="w-full rounded-full bg-white px-5 py-3.5 text-center font-medium text-[#111] placeholder-black/60 outline-none"
          />
        </form>
      )}

      {step === "loading" && (
        <div className="flex h-[54px] items-center gap-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-white"
              style={{ animationDelay: `${i * 150}ms` }}
            />
          ))}
        </div>
      )}

      {step === "card" &&
        (result ? (
          <ProofCard {...result} />
        ) : (
          <div className="flex h-[220px] w-full items-center justify-center rounded-2xl bg-white">
            {error ? (
              <p className="px-8 text-center text-sm font-medium text-gray-500">
                {error}
              </p>
            ) : (
              <svg
                viewBox="0 0 48 48"
                className="h-12 w-12 animate-spin"
                style={{ animationDuration: "1.6s" }}
                fill="#1E2AEB"
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
            )}
          </div>
        ))}
    </div>
  );
}
