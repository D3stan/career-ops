"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, Radar, Wrench } from "lucide-react";
import { CompanyLogo } from "@/components/company-logo";
import { useJobs, type Job } from "@/components/jobs/job-store";
import { cn } from "@/lib/cn";

type Company = { name: string; status: string; detail: string };
type JobStatus = "idle" | "running" | "done" | "failed" | "cancelled";
type VerifyJob = { status: JobStatus; startedAt?: string; finishedAt?: string; companies?: Company[]; error?: string };
type Poll = { available: boolean; configured: boolean; job: VerifyJob };

const TONE: Record<string, { dot: string; label: string; chip: string }> = {
  live: { dot: "bg-emerald-500", label: "live", chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  empty: { dot: "bg-amber-500", label: "live · empty", chip: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  broken: { dot: "bg-red-500", label: "broken", chip: "bg-red-500/15 text-red-700 dark:text-red-400" },
  skipped: { dot: "bg-zinc-400", label: "no ATS", chip: "bg-surface-hover text-muted" },
};
const ORDER: Record<string, number> = { broken: 0, empty: 1, live: 2, skipped: 3 };
const POLL_MS = 3000;

function elapsed(from?: string): string {
  if (!from) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(from)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function PortalsView() {
  // A run is a detached background job (verify-portals.mjs probes every
  // company's ATS sequentially and prints nothing until it's ALL done — see
  // lib/core/verify-job.ts — so an in-request call can only ever time out with
  // zero results once portals.yml has enough companies). This polls it.
  const [poll, setPoll] = useState<Poll | null>(null);
  const [tick, setTick] = useState(0); // re-render to advance the elapsed-time label
  const { jobs, startJob } = useJobs();
  const wasRunning = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/portals/verify-job");
      setPoll((await r.json()) as Poll);
    } catch {
      /* transient — next poll retries */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const running = poll?.job.status === "running";
    if (running) wasRunning.current = true;
    const t = setInterval(() => {
      if (running) {
        void refresh();
        setTick((n) => n + 1);
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [poll?.job.status, refresh]);

  const start = useCallback(async () => {
    try {
      const r = await fetch("/api/portals/verify-job", { method: "POST" });
      setPoll((await r.json()) as Poll);
    } catch {
      setPoll((p) => (p ? { ...p, job: { status: "failed", error: "Could not reach the server to start the check." } } : p));
    }
  }, []);

  const cancel = useCallback(async () => {
    try {
      const d = (await (await fetch("/api/portals/verify-job", { method: "DELETE" })).json()) as { job: VerifyJob };
      setPoll((p) => (p ? { ...p, job: d.job } : p));
    } catch {
      /* ignore */
    }
  }, []);

  // map the agentic "fix-portal" workers to the company they're repairing
  const fixByCompany = new Map<string, (typeof jobs)[number]>();
  for (const j of jobs) {
    if (j.kind !== "fix-portal" || !j.input) continue;
    const ex = fixByCompany.get(j.input);
    if (!ex || j.startedAt > ex.startedAt) fixByCompany.set(j.input, j);
  }

  const job = poll?.job;
  const running = job?.status === "running";
  const companies = job?.companies ?? [];
  const broken = companies.filter((c) => c.status === "broken");
  const liveN = companies.filter((c) => c.status === "live" || c.status === "empty").length;
  const sorted = [...companies].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
  const hasResults = job?.status === "done" && companies.length > 0;

  return (
    <div>
      <div className="flex items-center gap-3">
        <button
          onClick={() => void start()}
          disabled={running}
          className="inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-50 max-sm:min-h-[44px]"
        >
          {running ? <Loader2 className="size-4 animate-spin" /> : <Radar className="size-4" />}
          {running ? "Checking…" : "Check portal health"}
        </button>
        {running && (
          <span className="text-xs text-faint">
            {/* tick forces this label to advance while polling */}
            Probing each company&apos;s ATS, one at a time — {elapsed(job.startedAt)} so far. Runs in the background; you can leave this page.
            <span className="hidden">{tick}</span>
          </span>
        )}
        {running && (
          <button onClick={() => void cancel()} className="text-xs text-muted hover:text-foreground">
            Cancel
          </button>
        )}
      </div>

      {job?.status === "failed" && (
        <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          {job.error || "The check failed."}
        </p>
      )}
      {job?.status === "cancelled" && !hasResults && <p className="mt-4 text-sm text-muted">Check cancelled.</p>}

      {poll && !poll.available && (
        <p className="mt-4 rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
          <code className="text-foreground">verify-portals.mjs</code> not found — this needs a complete career-ops
          checkout (the web orchestrates the core&apos;s validator).
        </p>
      )}
      {poll && poll.available && !poll.configured && (
        <p className="mt-4 rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
          No <code className="text-foreground">portals.yml</code> yet — ask the assistant to set up the companies to scan.
        </p>
      )}

      {poll?.configured && hasResults && (
        <div className="mt-5">
          <p className="text-sm text-muted">
            <span className="tabular-nums text-emerald-600 dark:text-emerald-400">{liveN}</span> live ·{" "}
            <span className="tabular-nums text-red-600 dark:text-red-400">{broken.length}</span> broken ·{" "}
            <span className="tabular-nums">{companies.length}</span> tracked
          </p>
          {broken.length > 0 && (
            <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm">
              <span className="font-medium text-red-700 dark:text-red-400">
                {broken.length} {broken.length === 1 ? "company silently drops" : "companies silently drop"} from every
                scan
              </span>{" "}
              <span className="text-muted">
                — their careers link is broken. Fix the <code>careers_url</code> in <code>portals.yml</code> (or ask the
                assistant to repair them).
              </span>
            </div>
          )}
          <ul className="mt-4 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">
            {sorted.map((c) => {
              const t = TONE[c.status] ?? TONE.skipped;
              return (
                <li key={c.name} className="flex items-center gap-3 px-4 py-2.5">
                  <CompanyLogo name={c.name} size={20} />
                  <span className={cn("size-1.5 shrink-0 rounded-full", t.dot)} />
                  <span className="shrink-0 text-sm font-medium">{c.name}</span>
                  <span className="truncate font-mono text-xs text-faint">{c.detail}</span>
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    {c.status === "broken" && <FixAffordance company={c.name} job={fixByCompany.get(c.name)} onFix={() => startJob({ title: `Fix · ${c.name}`, subtitle: "repair portal slug", kind: "fix-portal", input: c.name, page: "/portals" })} />}
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", t.chip)}>{t.label}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function FixAffordance({ company, job, onFix }: { company: string; job?: Job; onFix: () => void }) {
  if (job?.status === "running")
    return (
      <Link href={`/jobs/${job.id}`} className="inline-flex items-center gap-1 text-xs font-medium text-brand">
        <Loader2 className="size-3 animate-spin" /> Fixing…
      </Link>
    );
  if (job?.status === "done")
    return (
      <Link href={`/jobs/${job.id}`} className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
        repaired · re-check
      </Link>
    );
  return (
    <button
      onClick={onFix}
      title={`Have the agent repair ${company}'s portal slug`}
      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted transition-colors hover:border-brand/40 hover:text-brand"
    >
      <Wrench className="size-3" /> Fix
    </button>
  );
}
