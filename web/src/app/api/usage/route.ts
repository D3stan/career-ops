import { NextResponse } from "next/server";
import os from "node:os";
import path from "node:path";
import { fetchAntigravityUsage } from "@/lib/antigravity-usage.mjs";
import { createUsageScanner } from "@/lib/claude-usage-scan.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reads Claude Code's per-message usage across ALL projects (~/.claude/projects/
// **/*.jsonl) and sums tokens in the rolling 5h and 7d windows — the same scope
// as the account's rate-limit windows. Cached 60s. The scanner keeps its place
// in each transcript and reads only what was appended since the last scan, with
// async fs, so a refresh no longer re-reads a week of transcripts while
// blocking the server (lib/claude-usage-scan.mjs).

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

const scanner = createUsageScanner({ root: path.join(os.homedir(), ".claude", "projects") });

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
  const data: Usage = { source: "claude", ...(await scanner.compute()) };
  cache = { at: Date.now(), data };
  return NextResponse.json(data);
}
