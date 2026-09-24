import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import { CAPS } from "@/lib/worker-capabilities.mjs";
import { titleSieveArgs } from "@/lib/title-sieve-args.mjs";
import { fencingReport } from "@/lib/cli-fencing.mjs";

// Title sieve: a title-only first pass over the listings Explore is showing.
// The prompt, the answer parser and every file write live in the core's
// title-sieve.mjs — this route only runs the user's CLI through the one fenced
// spawn path and hands the parsed verdicts to `title-sieve.mjs --apply`.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

const CALL_TIMEOUT_MS = 300_000;
const CONCURRENCY = 3;
const MAX_OFFERS = 400;

type SieveVerdict = "keep" | "unsure" | "drop" | "restored";
type SieveEntry = {
  url: string;
  date: string;
  verdict: SieveVerdict;
  reason: string;
  company: string;
  title: string;
  location: string;
  portal: string;
};

type SieveItem = { url: string; title: string; company: string; location: string; portal: string };
type SieveCore = {
  BATCH_SIZE: number;
  buildSievePrompt: (brief: string, items: SieveItem[]) => string;
  parseSieveResponse: (text: string, count: number) => { id: number; verdict: string; reason: string }[];
  attachResults: (batch: SieveItem[], answers: { id: number; verdict: string; reason: string }[]) => (SieveItem & { verdict: string; reason: string })[];
  parseSieveLog: (text: string) => Map<string, SieveEntry>;
  selectUnsieved: (items: SieveItem[], log: Map<string, SieveEntry>) => SieveItem[];
};

async function loadCore(): Promise<SieveCore | null> {
  const file = rootScript("title-sieve");
  if (!fs.existsSync(file)) return null;
  try {
    return (await import(/* webpackIgnore: true */ pathToFileURL(file).href)) as SieveCore;
  } catch {
    return null;
  }
}

function readLog(core: SieveCore): Map<string, SieveEntry> {
  try {
    return core.parseSieveLog(fs.readFileSync(path.join(careerOpsRoot(), "data", "title-sieve.tsv"), "utf8"));
  } catch {
    return new Map();
  }
}

/** Run the CLI once and collect stdout. Never rejects: failures come back as `error`. */
function runOnce(binPath: string, args: string[], cliId: string, cwd: string): Promise<{ stdout: string; error?: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnHeadlessCli(binPath, args, { cwd, env: process.env }, { cliId, capabilities: CAPS.webSearchOnly });
    } catch (e) {
      resolve({ stdout: "", error: e instanceof Error ? e.message : "failed to start the CLI" });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), CALL_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { stdout } : { stdout, error: `exit ${code ?? "signal"}${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}` });
    });
  });
}

type ApplySummary = { recorded?: number; skipped?: number; keep?: number; unsure?: number; drop?: number; movedInPipeline?: number; error?: string };

/** Hand the verdicts to the core writer, exactly as core/pipeline.ts does for "Add to pipeline". */
function applyViaCore(results: unknown[]): Promise<ApplySummary> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [rootScript("title-sieve"), "--apply"], { cwd: careerOpsRoot(), env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => resolve({ error: e.message }));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() || "{}"));
      } catch {
        resolve({ error: err.trim() || "title-sieve.mjs --apply returned no result" });
      }
    });
    child.stdin.end(JSON.stringify({ results }));
  });
}

function asItem(o: unknown): SieveItem | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const url = typeof r.url === "string" ? r.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) return null;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return { url, title: s(r.title), company: s(r.company), location: s(r.location), portal: s(r.ats) || s(r.portal) || s(r.source) };
}

/** Every URL's latest verdict — the UI annotates cards and lists what was sieved out. */
export async function GET() {
  const core = await loadCore();
  if (!core) return Response.json({ available: false, entries: [] });
  return Response.json({ available: true, entries: [...readLog(core).values()] });
}

export async function POST(req: Request) {
  let body: { cliId?: string; offers?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const cliId = body.cliId || "";
  if (!cliId) return Response.json({ error: "Pick a CLI in Settings first — the sieve runs on your own AI." }, { status: 400 });
  const core = await loadCore();
  if (!core) return Response.json({ error: "This checkout has no title-sieve.mjs — update career-ops." }, { status: 400 });
  const resolved = resolveCli(cliId);
  if (!resolved) return Response.json({ error: `CLI '${cliId}' not found on this machine` }, { status: 404 });
  const { spec, binPath } = resolved;

  let brief: string;
  try {
    brief = fs.readFileSync(path.join(careerOpsRoot(), "modes", "_brief.md"), "utf8");
  } catch {
    return Response.json({ error: "modes/_brief.md is missing — the sieve reads your triage brief." }, { status: 400 });
  }

  const items = (Array.isArray(body.offers) ? body.offers : []).map(asItem).filter((x): x is SieveItem => !!x);
  const todo = core.selectUnsieved(items, readLog(core)).slice(0, MAX_OFFERS);
  if (!todo.length) return Response.json({ summary: { recorded: 0, keep: 0, unsure: 0, drop: 0 }, failedBatches: 0, entries: [...readLog(core).values()] });

  const batches: SieveItem[][] = [];
  for (let i = 0; i < todo.length; i += core.BATCH_SIZE) batches.push(todo.slice(i, i + core.BATCH_SIZE));

  const argsFor = (prompt: string) => titleSieveArgs(cliId, prompt, spec.args);

  // An empty working directory: inside the repo an agent reads AGENTS.md and
  // starts running its session-start checks instead of answering.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-sieve-"));
  const results: unknown[] = [];
  const errors: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      const { stdout, error } = await runOnce(binPath, argsFor(core.buildSievePrompt(brief, batch)), cliId, cwd);
      const parsed = core.attachResults(batch, core.parseSieveResponse(stdout, batch.length));
      if (parsed.length) results.push(...parsed);
      else errors.push(error || "no usable answer");
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  fs.rmSync(cwd, { recursive: true, force: true });

  const summary: ApplySummary = results.length ? await applyViaCore(results) : { recorded: 0, keep: 0, unsure: 0, drop: 0 };
  if (summary.error) return Response.json({ error: `Could not record the verdicts: ${summary.error}`, entries: [...readLog(core).values()] }, { status: 500 });
  const fencing = fencingReport({ cliId, cliName: spec.name, capabilities: CAPS.webSearchOnly });
  return Response.json({
    summary,
    failedBatches: errors.length,
    error: !results.length && errors.length ? `The CLI gave no usable answer (${errors[0]}).` : undefined,
    notice: fencing.notice ?? undefined,
    entries: [...readLog(core).values()],
  });
}
