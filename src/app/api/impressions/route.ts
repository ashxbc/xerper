import { spawn } from "node:child_process";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
// Every request hits X live, so nothing here should be cached
export const dynamic = "force-dynamic";

const SCRIPT = path.join(process.cwd(), "scripts", "fetch_impressions.py");
const PYTHON = process.env.PYTHON_BIN ?? "python";
const TIMEOUT_MS = 120_000;

type Payload = {
  ok: boolean;
  error?: string;
  total_impressions?: number;
  post_count?: number;
  [key: string]: unknown;
};

function runFetcher(username: string, project: string): Promise<Payload> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [SCRIPT], {
      env: process.env,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out talking to X"));
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", () => {
      clearTimeout(timer);
      if (stderr.trim()) console.error("[impressions]", stderr.trim());

      try {
        resolve(JSON.parse(stdout) as Payload);
      } catch {
        reject(new Error(stderr.trim() || "Fetcher returned no JSON"));
      }
    });

    child.stdin.write(JSON.stringify({ username, project }));
    child.stdin.end();
  });
}

export async function POST(request: Request) {
  let username: string;
  let project: string;

  try {
    const body = await request.json();
    username = String(body.username ?? "").trim();
    project = String(body.project ?? "").trim();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!username || !project) {
    return NextResponse.json(
      { ok: false, error: "username and project are both required" },
      { status: 400 },
    );
  }

  try {
    const payload = await runFetcher(username, project);
    return NextResponse.json(payload, { status: payload.ok ? 200 : 502 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
