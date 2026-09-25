import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";

/**
 * Background "Check portal health": ONE detached run of the core's
 * `verify-portals.mjs`.
 *
 * `verify-portals.mjs` probes every tracked company's ATS SEQUENTIALLY on
 * purpose ("stay gentle on rate limits" — its own comment), and it prints
 * NOTHING until the whole sweep is done: `printResults()` runs once, after
 * `verifyPortalsFile()` resolves. With 181 companies that sweep takes ~170s.
 *
 * The route this replaced ran it in-request with `execFile(..., { timeout:
 * 110_000 })`. Because nothing prints before completion, killing it at 110s
 * didn't yield a partial list — it yielded NOTHING, which is exactly the "0
 * live · 0 broken · 0 tracked" the UI showed. Raising the timeout only delays
 * the same failure as portals.yml grows (verify-portals.mjs stays intentionally
 * sequential — see its own comment — so this only gets slower over time, never
 * faster). So this runs the same way Explore's background scan does: spawned
 * detached, polled, immune to the page closing or a request timeout.
 */

export type PortalStatus = "live" | "empty" | "broken" | "skipped";
export type PortalRow = { name: string; status: PortalStatus; detail: string };

export type VerifyJobState = {
  status: "idle" | "running" | "done" | "failed" | "cancelled";
  pid?: number;
  startedAt?: string;
  finishedAt?: string;
  companies?: PortalRow[];
  error?: string;
};

const ROW_RE = /^\s*(✅|🟡|❌|➖)\s+(.+?)\s+—\s+(.*)$/;
const STATUS: Record<string, PortalStatus> = { "✅": "live", "🟡": "empty", "❌": "broken", "➖": "skipped" };

/** Parse `verify-portals.mjs`'s printed report into rows — same regex the old in-request route used. */
export function parseVerifyOutput(text: string): PortalRow[] {
  const rows: PortalRow[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(ROW_RE);
    if (m) rows.push({ name: m[2].trim(), status: STATUS[m[1]] ?? "skipped", detail: m[3].trim() });
  }
  return rows;
}

function paths() {
  const dir = path.join(careerOpsRoot(), "data", "cache");
  return { dir, state: path.join(dir, "verify-portals.json"), out: path.join(dir, "verify-portals.out.log") };
}

function readState(): VerifyJobState & { pidStartedAt?: string } {
  try {
    return JSON.parse(fs.readFileSync(paths().state, "utf8"));
  } catch {
    return { status: "idle" };
  }
}

function writeState(s: VerifyJobState) {
  const p = paths();
  fs.mkdirSync(p.dir, { recursive: true });
  const tmp = `${p.state}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, p.state);
}

function isAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True when this checkout can run a health check at all — mirrors the old route's `available`/`configured`. */
export function verifyAvailability(): { available: boolean; configured: boolean } {
  const available = fs.existsSync(rootScript("verify-portals"));
  const configured = available && fs.existsSync(path.join(careerOpsRoot(), "portals.yml"));
  return { available, configured };
}

export function getVerifyJob(): VerifyJobState {
  const s = readState();
  if (s.status !== "running") return s;
  if (isAlive(s.pid)) return s;

  // Process is gone: read whatever it wrote. A clean run's whole report lands
  // here in one shot (see the module doc — nothing streams mid-sweep).
  const p = paths();
  let text = "";
  try {
    text = fs.readFileSync(p.out, "utf8");
  } catch {
    /* nothing captured */
  }
  const companies = parseVerifyOutput(text);
  const settled: VerifyJobState = companies.length
    ? { status: "done", startedAt: s.startedAt, finishedAt: new Date().toISOString(), companies }
    : {
        status: "failed",
        startedAt: s.startedAt,
        finishedAt: new Date().toISOString(),
        error: text.trim().split("\n").slice(-3).join(" · ") || "verify-portals.mjs produced no output.",
      };
  writeState(settled);
  return settled;
}

export function startVerifyJob(): VerifyJobState {
  const current = getVerifyJob();
  if (current.status === "running") return current;

  const { available, configured } = verifyAvailability();
  if (!available || !configured) {
    return { status: "failed", error: !available ? "verify-portals.mjs not found in this checkout." : "No portals.yml yet." };
  }

  const p = paths();
  fs.mkdirSync(p.dir, { recursive: true });
  const out = fs.openSync(p.out, "w");
  const child = spawn(process.execPath, [rootScript("verify-portals")], {
    cwd: careerOpsRoot(),
    env: process.env,
    // Own process group + no pipes back to us: the sweep outlives this request
    // and a dev-server reload, same as Explore's background scan.
    detached: true,
    stdio: ["ignore", out, out],
  });
  fs.closeSync(out);
  child.unref();

  const state: VerifyJobState = { status: "running", pid: child.pid, startedAt: new Date().toISOString() };
  writeState(state);
  return state;
}

export function cancelVerifyJob(): VerifyJobState {
  const s = readState();
  if (s.status !== "running" || !isAlive(s.pid)) return getVerifyJob();
  try {
    process.kill(-(s.pid as number), "SIGTERM");
  } catch {
    try {
      process.kill(s.pid as number, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const cancelled: VerifyJobState = { status: "cancelled", startedAt: s.startedAt, finishedAt: new Date().toISOString() };
  writeState(cancelled);
  return cancelled;
}
