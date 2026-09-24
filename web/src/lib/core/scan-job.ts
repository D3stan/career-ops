import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { writeTempPortals, cleanupTempPortals } from "./portals";
import { ATS_SOURCES, type ExploreFilters } from "@/lib/explore";

/**
 * Background Discover: ONE detached run of the core's `scan-ats-full.mjs`.
 *
 * A full sweep is crawler-bound (Workday boards page 20 jobs at a time, re-query
 * past their 2,000-result cap and fetch detail pages for dates), so it routinely
 * runs 20+ minutes — far past any request a browser can hold open. So the run is
 * NOT tied to a request: it is spawned detached, writes its --json result and its
 * progress log to data/cache/, and its state lives in a small JSON file. The page
 * polls; closing the tab or reloading the dev server does not stop the scan.
 *
 * Unlike the old in-request discovery this is a REAL scan (no --dry-run): matches
 * land in data/pipeline.md and data/scan-history.tsv exactly as a CLI scan would,
 * which is what makes them show up in Explore's fresh list afterwards.
 */

export type ScanJobState = {
  status: "idle" | "running" | "done" | "failed" | "cancelled";
  pid?: number;
  startedAt?: string;
  finishedAt?: string;
  ats?: string[];
  sinceDays?: number;
  limitPerAts?: number;
  /** Latest human progress line from the scanner's log, e.g. "workday — 40/150 scanned". */
  progress?: string;
  result?: { companiesScanned: number; companiesAvailable?: number; matches: number; unreachable: number; capHit?: boolean };
  error?: string;
};

type StoredState = ScanJobState & { portalsFile?: string };

function paths() {
  const dir = path.join(careerOpsRoot(), "data", "cache");
  return {
    dir,
    state: path.join(dir, "explore-scan.json"),
    out: path.join(dir, "explore-scan.out.json"),
    log: path.join(dir, "explore-scan.log"),
  };
}

function readState(): StoredState {
  try {
    return JSON.parse(fs.readFileSync(paths().state, "utf8")) as StoredState;
  } catch {
    return { status: "idle" };
  }
}

function writeState(s: StoredState) {
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

const ATS_START_RE = /⚙\s+(\S+)\s+—\s+(\d+)\s+companies/;
const PROGRESS_RE = /(\d+)\/(\d+)\s+scanned,\s+(\d+)\s+total matches/;

/** "workday — 40/150 companies · 3 matches so far" from the tail of the log. */
export function progressFromLog(log: string): string {
  let ats = "";
  let prog = "";
  for (const raw of log.split(/[\r\n]+/)) {
    const line = raw.trim();
    const a = line.match(ATS_START_RE);
    if (a) {
      ats = a[1];
      prog = `0/${a[2]} companies`;
      continue;
    }
    const p = line.match(PROGRESS_RE);
    if (p) prog = `${p[1]}/${p[2]} companies · ${p[3]} match${p[3] === "1" ? "" : "es"} so far`;
  }
  return ats ? `${ats} — ${prog}` : "Downloading the ATS company directories…";
}

function tail(file: string, bytes = 16_000): string {
  try {
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(bytes, size));
    fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

/** Current state; settles a finished run (reads its JSON, cleans its temp file). */
export function getScanJob(): ScanJobState {
  const s = readState();
  if (s.status !== "running") return strip(s);
  const p = paths();
  if (isAlive(s.pid)) return strip({ ...s, progress: progressFromLog(tail(p.log)) });

  // The process is gone: its stdout file holds the one --json object, or nothing.
  let settled: StoredState;
  try {
    const j = JSON.parse(fs.readFileSync(p.out, "utf8").trim());
    settled = {
      ...s,
      status: "done",
      finishedAt: new Date().toISOString(),
      progress: undefined,
      result: {
        companiesScanned: j.companiesScanned ?? 0,
        companiesAvailable: j.companiesAvailable,
        matches: j.postingsKept ?? (Array.isArray(j.offers) ? j.offers.length : 0),
        unreachable: j.unreachableBoards ?? 0,
        capHit: j.capHit,
      },
    };
  } catch {
    const lastLines = tail(p.log, 4000).trim().split("\n").slice(-3).join(" · ");
    settled = { ...s, status: "failed", finishedAt: new Date().toISOString(), progress: undefined, error: lastLines || "The scanner stopped without a result." };
  }
  if (s.portalsFile) cleanupTempPortals(s.portalsFile);
  writeState({ ...settled, portalsFile: undefined });
  return strip(settled);
}

function strip(s: StoredState): ScanJobState {
  const { portalsFile: _omit, ...rest } = s;
  void _omit;
  return rest;
}

export function startScanJob(filters: ExploreFilters): ScanJobState {
  const current = getScanJob();
  if (current.status === "running") return current;

  const p = paths();
  fs.mkdirSync(p.dir, { recursive: true });
  const ats = (filters.ats.length ? filters.ats : [...ATS_SOURCES]).filter((a) => (ATS_SOURCES as readonly string[]).includes(a));
  const sinceDays = Math.max(1, filters.sinceDays || 7);
  const limitPerAts = Math.max(1, filters.limitPerAts || 150);
  const portalsFile = writeTempPortals(filters);
  const out = fs.openSync(p.out, "w");
  const log = fs.openSync(p.log, "w");

  const child = spawn(
    process.execPath,
    [rootScript("scan-ats-full"), "--since", String(sinceDays), "--ats", ats.join(","), "--limit", String(limitPerAts), "--json"],
    {
      cwd: careerOpsRoot(),
      env: { ...process.env, CAREER_OPS_PORTALS: portalsFile },
      // Own process group + no pipes back to us: the scan outlives this request
      // and a dev-server reload.
      detached: true,
      stdio: ["ignore", out, log],
    },
  );
  fs.closeSync(out);
  fs.closeSync(log);
  child.unref();

  const state: StoredState = {
    status: "running",
    pid: child.pid,
    startedAt: new Date().toISOString(),
    ats,
    sinceDays,
    limitPerAts,
    portalsFile,
  };
  writeState(state);
  return strip({ ...state, progress: "Starting…" });
}

export function cancelScanJob(): ScanJobState {
  const s = readState();
  if (s.status !== "running" || !isAlive(s.pid)) return getScanJob();
  try {
    process.kill(-(s.pid as number), "SIGTERM"); // the whole detached group
  } catch {
    try {
      process.kill(s.pid as number, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  if (s.portalsFile) cleanupTempPortals(s.portalsFile);
  const cancelled: StoredState = { ...s, status: "cancelled", finishedAt: new Date().toISOString(), portalsFile: undefined };
  writeState(cancelled);
  return strip(cancelled);
}
