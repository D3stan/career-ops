"use client";

import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { cn } from "@/lib/cn";
import { resolveCliId } from "@/lib/saved-cli";

type ClaudeUsage = { source: "claude"; window5h: { tokens: number }; window7d: { tokens: number } };
type AntigravityUsage =
  | { source: "antigravity"; ok: true; window5h: { usedPct: number; resetTime: string }; weekly: { usedPct: number; resetTime: string } }
  | { source: "antigravity"; ok: false };
type Usage = ClaudeUsage | AntigravityUsage;

// Soft budgets (tunable via localStorage `career-ops:usage-budget`). The bar
// colour is the "brake" signal — set these to your plan's real limits.
const DEFAULT_BUDGET = { w5: 140_000_000, w7: 1_000_000_000 };

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}
function tone(pct: number): string {
  if (pct >= 85) return "bg-red-400";
  if (pct >= 60) return "bg-amber-400";
  return "bg-emerald-400";
}
function resetLabel(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return "resets soon";
  const hours = ms / 3_600_000;
  if (hours < 36) return `resets in ${Math.max(1, Math.round(hours))}h`;
  return `resets in ${Math.round(hours / 24)}d`;
}

export function UsageMeter() {
  const [data, setData] = useState<Usage | null>(null);
  // null = not yet resolved (render nothing rather than guess); "" would mean
  // "resolved to no CLI at all", which resolveCliId() never actually returns.
  const [cli, setCli] = useState<string | null>(null);
  const [budget, setBudget] = useState(DEFAULT_BUDGET);

  useEffect(() => {
    let alive = true;
    // Auto-detects + persists even if the Config page was never opened —
    // reading localStorage directly here used to default to "assume Claude"
    // whenever career-ops:config hadn't been written yet, which is why this
    // meter kept showing a Claude-shaped 0% while running under a different CLI.
    resolveCliId().then((id) => {
      if (alive) setCli(id);
    });
    try {
      const b = localStorage.getItem("career-ops:usage-budget");
      if (b) setBudget({ ...DEFAULT_BUDGET, ...JSON.parse(b) });
    } catch {
      /* ignore */
    }
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    // Nothing to fetch until we know which CLI's usage source to ask for.
    if (!cli || (cli !== "claude" && cli !== "antigravity")) return;
    let alive = true;
    const load = () =>
      fetch(`/api/usage?cli=${cli}`)
        .then((r) => r.json())
        .then((d) => {
          if (alive) setData(d);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [cli]);

  // No usage source exists for this CLI (codex, gemini, opencode, ...) — hide
  // rather than show a meter that can never mean anything for it.
  if (!cli || (cli !== "claude" && cli !== "antigravity")) return null;
  if (!data) return null;
  // Antigravity's own /usage call failed (not signed in, network hiccup, timed
  // out) and there was no recent cached reading to fall back to — hide rather
  // than show a 0% that looks like "no usage" when it actually means "unknown".
  if (data.source === "antigravity" && !data.ok) return null;

  const rows =
    data.source === "claude"
      ? [
          { label: "5h", pct: Math.min(100, Math.round(((data.window5h?.tokens ?? 0) / budget.w5) * 100)), title: `${(data.window5h?.tokens ?? 0).toLocaleString()} tokens in the last 5h`, display: fmt(data.window5h?.tokens ?? 0) },
          { label: "7d", pct: Math.min(100, Math.round(((data.window7d?.tokens ?? 0) / budget.w7) * 100)), title: `${(data.window7d?.tokens ?? 0).toLocaleString()} tokens in the last 7d`, display: fmt(data.window7d?.tokens ?? 0) },
        ]
      : [
          { label: "5h", pct: data.window5h.usedPct, title: `Gemini models, ${resetLabel(data.window5h.resetTime)}`, display: null },
          { label: "Weekly", pct: data.weekly.usedPct, title: `Gemini models, ${resetLabel(data.weekly.resetTime)}`, display: null },
        ];

  return (
    <div className="border-t border-border pt-3">
      <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">
        <Gauge className="size-3" /> Usage
      </div>
      <div className="space-y-2 px-1">
        {rows.map((r) => (
          <div key={r.label} title={r.title}>
            <div className="flex items-center justify-between text-[10px] text-faint">
              <span>{r.label}</span>
              <span className="tabular-nums">
                {r.display !== null ? `${r.display} · ${r.pct}%` : `${r.pct}%`}
              </span>
            </div>
            <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-surface-hover">
              <div
                className={cn("h-full rounded-full transition-all", tone(r.pct))}
                style={{ width: `${Math.max(r.pct, 2)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
