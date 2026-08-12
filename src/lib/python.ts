import { spawn } from "node:child_process";
import path from "node:path";

/** Locate a Python that can actually run the fetcher.
 *
 *  `spawn("python")` throws ENOENT whenever the Next process did not inherit a
 *  PATH containing Python - which is most of the time on Windows, since the
 *  installer only adds it to the user PATH of shells opened afterwards.
 *
 *  Two Windows traps make a plain "does python exist" check insufficient:
 *  `python3` is usually a Microsoft Store stub that exits non-zero, and a
 *  machine can have several Pythons where only one has the dependencies. So
 *  candidates are probed by importing httpx, not by --version.
 */

export type Interpreter = { cmd: string; args: string[] };

let cached: Promise<Interpreter> | null = null;

function candidates(): Interpreter[] {
  const found: Interpreter[] = [];

  if (process.env.PYTHON_BIN) {
    found.push({ cmd: process.env.PYTHON_BIN, args: [] });
  }

  found.push({ cmd: "python", args: [] });
  found.push({ cmd: "py", args: ["-3"] });
  found.push({ cmd: "python3", args: [] });

  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA;
    if (base) {
      // Newest first, but the httpx probe is what actually decides
      for (const version of [
        "Python313",
        "Python312",
        "Python311",
        "Python310",
      ]) {
        found.push({
          cmd: path.join(base, "Programs", "Python", version, "python.exe"),
          args: [],
        });
      }
    }
  } else {
    found.push({ cmd: "/usr/bin/python3", args: [] });
    found.push({ cmd: "/usr/local/bin/python3", args: [] });
  }

  const seen = new Set<string>();
  return found.filter((entry) => {
    const key = `${entry.cmd} ${entry.args.join(" ")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function canRunFetcher(interpreter: Interpreter): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(interpreter.cmd, [...interpreter.args, "-c", "import httpx"], {
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 10_000);

    child.on("error", () => {
      clearTimeout(timer);
      resolve(false); // ENOENT for this candidate - try the next
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function find(): Promise<Interpreter> {
  const tried: string[] = [];

  for (const interpreter of candidates()) {
    if (await canRunFetcher(interpreter)) return interpreter;
    tried.push([interpreter.cmd, ...interpreter.args].join(" "));
  }

  throw new Error(
    "No Python with the required packages was found. Run " +
      "`pip install -r requirements.txt`, or set PYTHON_BIN in .env.local to " +
      "the full path of your python.exe. Tried: " +
      tried.join(", "),
  );
}

export function pythonInterpreter(): Promise<Interpreter> {
  if (!cached) {
    // Drop the cache on failure so a fixed install is picked up without a restart
    cached = find().catch((error) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}
