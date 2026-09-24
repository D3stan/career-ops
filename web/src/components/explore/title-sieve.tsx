"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Filter, Loader2, RotateCcw, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { resolveCliId } from "@/lib/saved-cli";
import type { DiscoveredOffer } from "@/lib/explore";
import { CostBadge } from "@/components/cost/cost-badge";

// Title sieve (core: title-sieve.mjs). One cheap LLM pass over the TITLES on
// screen → keep / unsure / drop. Drops leave the list (and the pipeline) but stay
// listed under "Sieved out", one click from being restored.

export type SieveVerdict = "keep" | "unsure" | "drop" | "restored";
export type SieveEntry = {
  url: string;
  date: string;
  verdict: SieveVerdict;
  reason: string;
  company: string;
  title: string;
  location: string;
};

type Notice = { tone: "ok" | "warn" | "error"; text: string } | null;

export function useTitleSieve() {
  const [entries, setEntries] = useState<Map<string, SieveEntry>>(new Map());
  const [available, setAvailable] = useState(true);
  const [running, setRunning] = useState(false);
  const [restoring, setRestoring] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<Notice>(null);

  const ingest = (list: unknown) => {
    if (!Array.isArray(list)) return;
    setEntries(new Map((list as SieveEntry[]).map((e) => [e.url, e])));
  };

  const load = useCallback(async () => {
    try {
      const d = await (await fetch("/api/whats-new/sieve")).json();
      setAvailable(d.available !== false);
      ingest(d.entries);
    } catch {
      /* the list still works without verdicts */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(async (offers: DiscoveredOffer[]) => {
    setRunning(true);
    setNotice(null);
    try {
      const cliId = await resolveCliId();
      if (!cliId) {
        setNotice({ tone: "error", text: "No AI CLI configured — pick one in Settings; the sieve runs on your own AI." });
        return;
      }
      const r = await fetch("/api/whats-new/sieve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cliId, offers }),
      });
      const d = await r.json();
      ingest(d.entries);
      if (!r.ok || d.error) {
        setNotice({ tone: "error", text: d.error || "The sieve failed." });
        return;
      }
      const s = d.summary || {};
      const parts = [`${s.keep ?? 0} keep`, `${s.unsure ?? 0} unsure`, `${s.drop ?? 0} sieved out`];
      const failed = d.failedBatches ? ` · ${d.failedBatches} batch(es) got no usable answer and stay un-sieved` : "";
      setNotice({ tone: d.failedBatches ? "warn" : "ok", text: `${parts.join(" · ")}${failed}${d.notice ? ` · ⚠️ ${d.notice}` : ""}` });
    } catch {
      setNotice({ tone: "error", text: "The sieve request failed — is the server reachable?" });
    } finally {
      setRunning(false);
    }
  }, []);

  const restore = useCallback(
    async (url: string) => {
      setRestoring((s) => new Set(s).add(url));
      try {
        const r = await fetch("/api/whats-new/sieve/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const d = await r.json();
        if (!r.ok) setNotice({ tone: "error", text: d.error || "Restore failed." });
        await load();
      } finally {
        setRestoring((s) => {
          const n = new Set(s);
          n.delete(url);
          return n;
        });
      }
    },
    [load],
  );

  return { entries, available, running, restoring, notice, run, restore };
}

export type TitleSieve = ReturnType<typeof useTitleSieve>;

/** Sort key for the "fit" order: keep → unsure → not yet sieved. */
export function sieveRank(verdict: SieveVerdict | undefined): number {
  return verdict === "keep" ? 0 : verdict === "unsure" ? 1 : 2;
}

export function SieveBar({ sieve, offers }: { sieve: TitleSieve; offers: DiscoveredOffer[] }) {
  const [showDropped, setShowDropped] = useState(false);
  const pending = useMemo(() => offers.filter((o) => !sieve.entries.has(o.url)), [offers, sieve.entries]);
  const allDropped = useMemo(
    () => [...sieve.entries.values()].filter((e) => e.verdict === "drop").sort((a, b) => b.date.localeCompare(a.date)),
    [sieve.entries],
  );
  // The list renders at most this many rows; the count stays the real total.
  const dropped = useMemo(() => allDropped.slice(0, 150), [allDropped]);
  if (!sieve.available) return null;

  return (
    <div className="rounded-xl border border-border bg-surface/30 px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          disabled={sieve.running || pending.length === 0}
          onClick={() => void sieve.run(pending)}
          title="One cheap AI pass over the titles only (no job descriptions): keep / unsure / drop, based on your triage brief."
          className="inline-flex items-center gap-1.5 rounded-lg border border-brand/30 px-2.5 py-1.5 text-xs font-medium text-brand transition-colors hover:bg-brand-soft disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sieve.running ? <Loader2 className="size-3.5 animate-spin" /> : <Filter className="size-3.5" />}
          {sieve.running ? `Sieving ${pending.length} titles…` : pending.length ? `Sieve ${pending.length} title${pending.length === 1 ? "" : "s"}` : "All titles sieved"}
        </button>
        <CostBadge kind="spend" size="xs" />
        {sieve.notice && (
          <span
            className={cn(
              "text-[12px]",
              sieve.notice.tone === "error" ? "text-red-600 dark:text-red-400" : sieve.notice.tone === "warn" ? "text-amber-600 dark:text-amber-300" : "text-muted",
            )}
          >
            {sieve.notice.text}
          </span>
        )}
        {dropped.length > 0 && (
          <button
            type="button"
            onClick={() => setShowDropped((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-foreground"
          >
            Sieved out ({allDropped.length})
            <ChevronDown className={cn("size-3.5 transition-transform", showDropped && "rotate-180")} />
          </button>
        )}
      </div>

      {showDropped && dropped.length > 0 && (
        <ul className="mt-2.5 divide-y divide-border border-t border-border">
          {dropped.map((e) => (
            <li key={e.url} className="flex items-center gap-3 py-1.5 text-[12px]">
              <a href={e.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-foreground hover:text-brand">
                {e.title} <span className="text-faint">· {e.company}</span>
              </a>
              <span className="hidden shrink-0 truncate text-faint sm:block sm:max-w-[40%]">{e.reason}</span>
              <button
                type="button"
                disabled={sieve.restoring.has(e.url)}
                onClick={() => void sieve.restore(e.url)}
                className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
              >
                {sieve.restoring.has(e.url) ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />} Restore
              </button>
            </li>
          ))}
          {allDropped.length > dropped.length && (
            <li className="py-1.5 text-[12px] text-faint">
              Showing the latest {dropped.length} of {allDropped.length}. Older ones: <code>data/title-sieve.tsv</code>, or <code>node title-sieve.mjs --log</code>.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export function SieveBadge({ entry }: { entry?: SieveEntry }) {
  if (!entry || (entry.verdict !== "keep" && entry.verdict !== "unsure")) return null;
  const keep = entry.verdict === "keep";
  return (
    <span
      title={entry.reason ? `Title sieve: ${entry.reason}` : "Title sieve"}
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded border px-1.5 py-0.5 font-medium",
        keep
          ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-300",
      )}
    >
      {keep ? "keep" : "unsure"}
      {entry.reason && <span className="truncate font-normal opacity-80">· {entry.reason}</span>}
    </span>
  );
}
