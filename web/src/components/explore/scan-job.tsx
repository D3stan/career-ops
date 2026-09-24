"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, CheckCircle2, AlertTriangle, X } from "lucide-react";
import type { ExploreFilters } from "@/lib/explore";

// Client half of background Discover (server: lib/core/scan-job.ts). The scan
// runs detached on the server; this polls its state, and calls `onFinished`
// once when a run this page watched completes, so the fresh list can reload.

type ScanJob = {
  status: "idle" | "running" | "done" | "failed" | "cancelled";
  startedAt?: string;
  finishedAt?: string;
  ats?: string[];
  progress?: string;
  result?: { companiesScanned: number; companiesAvailable?: number; matches: number; unreachable: number; capHit?: boolean };
  error?: string;
};

const POLL_MS = 4000;

export function useScanJob(onFinished: () => void) {
  const [job, setJob] = useState<ScanJob>({ status: "idle" });
  const [dismissed, setDismissed] = useState(false);
  const wasRunning = useRef(false);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  const apply = useCallback((j: ScanJob) => {
    setJob(j);
    if (j.status === "running") wasRunning.current = true;
    else if (wasRunning.current) {
      wasRunning.current = false;
      if (j.status === "done") finished.current();
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply((await (await fetch("/api/explore/scan-job")).json()) as ScanJob);
    } catch {
      /* transient — next poll retries */
    }
  }, [apply]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (job.status !== "running") return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [job.status, refresh]);

  const start = useCallback(
    async (filters: ExploreFilters) => {
      setDismissed(false);
      try {
        const r = await fetch("/api/explore/scan-job", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(filters),
        });
        const d = await r.json();
        apply(r.ok ? d : { status: "failed", error: d.error || `Could not start the scan (${r.status}).` });
      } catch {
        apply({ status: "failed", error: "Could not reach the server to start the scan." });
      }
    },
    [apply],
  );

  const cancel = useCallback(async () => {
    try {
      apply((await (await fetch("/api/explore/scan-job", { method: "DELETE" })).json()) as ScanJob);
    } catch {
      /* ignore */
    }
  }, [apply]);

  return { job, running: job.status === "running", start, cancel, dismissed, dismiss: () => setDismissed(true) };
}

function elapsed(from?: string): string {
  if (!from) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(from)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function ScanJobBanner({ scan }: { scan: ReturnType<typeof useScanJob> }) {
  const { job } = scan;
  if (job.status === "idle" || scan.dismissed) return null;

  if (job.status === "running") {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-brand/30 bg-brand-soft/40 px-4 py-3 text-[13px]">
        <Loader2 className="size-4 shrink-0 animate-spin text-brand" />
        <span className="font-medium text-foreground">Scanning in the background</span>
        <span className="text-muted">{job.progress}</span>
        <span className="text-faint">· {elapsed(job.startedAt)}</span>
        <span className="basis-full text-[12px] text-faint sm:basis-auto">
          A full sweep can take 20+ minutes (Workday is slow). You can leave this page; new matches appear here when it finishes.
        </span>
        <button type="button" onClick={() => void scan.cancel()} className="ml-auto text-xs text-muted hover:text-foreground">
          Cancel
        </button>
      </div>
    );
  }

  const ok = job.status === "done";
  const r = job.result;
  const text = ok
    ? `Scan finished — ${r?.matches ?? 0} new match${r?.matches === 1 ? "" : "es"} across ${(r?.companiesScanned ?? 0).toLocaleString()} companies${r?.unreachable ? ` (${r.unreachable} boards unreachable)` : ""}.`
    : job.status === "cancelled"
      ? "Scan cancelled."
      : `Scan failed: ${job.error || "unknown error"}`;
  return (
    <div
      className={
        ok
          ? "mb-4 flex items-center gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-[13px] text-foreground"
          : "mb-4 flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-[13px] text-foreground"
      }
    >
      {ok ? <CheckCircle2 className="size-4 shrink-0 text-emerald-500" /> : <AlertTriangle className="size-4 shrink-0 text-amber-500" />}
      <span className="min-w-0 flex-1">{text}</span>
      <button type="button" onClick={scan.dismiss} aria-label="Dismiss" className="text-muted hover:text-foreground">
        <X className="size-4" />
      </button>
    </div>
  );
}
