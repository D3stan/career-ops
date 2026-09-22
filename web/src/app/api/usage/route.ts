import { NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchAntigravityUsage } from "@/lib/antigravity-usage.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reads Claude Code's per-message usage across ALL projects (~/.claude/projects/
// **/*.jsonl) and sums tokens in the rolling 5h and 7d windows — the same scope
// as the account's rate-limit windows. Cached 60s (the read is heavy).

type Usage = { source: "claude"; window5h: { tokens: number; messages: number }; window7d: { tokens: number; messages: number }; computedAt: number };
let cache: { at: number; data: Usage } | null = null;

// Antigravity has no local log to sum — its own `/usage` command is the only
// source, and it costs a 7-10s process spawn + auth round trip per call (see
// antigravity-usage.mjs). Cache it far longer than the Claude path so a page
// with several clients polling every 60s doesn't re-spawn agy on every poll.
type AntigravityUsage =
  | { source: "antigravity"; ok: true; window5h: { usedPct: number; resetTime: string }; weekly: { usedPct: number; resetTime: string }; computedAt: number }
  | { source: "antigravity"; ok: false; computedAt: number };
const ANTIGRAVITY_CACHE_MS = 5 * 60 * 1000;
let antigravityCache: { at: number; data: AntigravityUsage } | null = null;

async function computeAntigravity(): Promise<AntigravityUsage> {
  const now = Date.now();
  const result = await fetchAntigravityUsage();
  if (!result.ok) {
    // A transient failure (auth hiccup, agy not signed in yet) shouldn't flash
    // the meter to a false "unavailable" — prefer the last good reading as
    // long as it's not ancient.
    if (antigravityCache?.data.ok && now - antigravityCache.at < 30 * 60 * 1000) {
      return antigravityCache.data;
    }
    return { source: "antigravity", ok: false, computedAt: now };
  }
  return { source: "antigravity", ok: true, window5h: result.window5h, weekly: result.weekly, computedAt: now };
}

function projectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

function* walkJsonl(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.isFile() && e.name.endsWith(".jsonl")) yield p;
  }
}

function compute(): Usage {
  const now = Date.now();
  const w5 = now - 5 * 3600 * 1000;
  const w7 = now - 7 * 24 * 3600 * 1000;
  const cutoffMtime = w7 - 3600 * 1000;
  let t5 = 0;
  let t7 = 0;
  let m5 = 0;
  let m7 = 0;

  for (const file of walkJsonl(projectsDir())) {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoffMtime) continue;
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.includes('"usage"')) continue;
      let d: { message?: { usage?: Record<string, number> }; timestamp?: string };
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const u = d.message?.usage;
      const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
      if (!u || Number.isNaN(ts) || ts < w7) continue;
      const tok = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
      t7 += tok;
      m7 += 1;
      if (ts >= w5) {
        t5 += tok;
        m5 += 1;
      }
    }
  }
  return { source: "claude", window5h: { tokens: t5, messages: m5 }, window7d: { tokens: t7, messages: m7 }, computedAt: now };
}

export async function GET(req: Request) {
  const cli = new URL(req.url).searchParams.get("cli") || "claude";

  if (cli === "antigravity") {
    if (antigravityCache && Date.now() - antigravityCache.at < ANTIGRAVITY_CACHE_MS) {
      return NextResponse.json(antigravityCache.data);
    }
    const data = await computeAntigravity();
    antigravityCache = { at: Date.now(), data };
    return NextResponse.json(data);
  }

  if (cache && Date.now() - cache.at < 60_000) return NextResponse.json(cache.data);
  const data = compute();
  cache = { at: Date.now(), data };
  return NextResponse.json(data);
}
