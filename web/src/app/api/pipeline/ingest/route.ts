import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withPipelineLock, PipelineBusyError, getDataRoot } from "../../../../lib/core/pipeline-lock.mjs";
import { atomicWrite } from "../../../../lib/core/safe-write.mjs";
import { normalizeUrl } from "../../../../lib/core/url-key.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CleanJob {
  url: string;
  company: string;
  role: string;
  location?: string;
  compensation?: string;
}

const PIPELINE_SKELETON = `# Pipeline — Pending URLs

Paste job URLs below as \`- [ ] {url}\` then run \`/career-ops pipeline\`.

## Pending

## Processed
`;

const PENDING_MARKERS = ["## Pending", "## Pendientes"];
const PROCESSED_MARKERS = ["## Processed", "## Procesadas"];

const MAX_JOBS_PER_REQUEST = 5000;

// Hash both sides first so the comparison is constant-time and does not leak
// the secret's length.
function timingSafeCompare(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function getLocalToday(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

const LEGAL_SUFFIXES = [
  "incorporated", "inc", "corporation", "corp", "company", "co",
  "limited", "ltd", "llc", "llp", "lp", "plc",
];

function normalizeCompanyName(name: string): string {
  let key = String(name ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{M}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      const re = new RegExp(`\\s${suffix}$`);
      if (re.test(key)) {
        key = key.replace(re, "").trim();
        changed = true;
      }
    }
  }

  return key;
}

function insertPendingOffers(text: string, formattedLines: string[]): string {
  if (formattedLines.length === 0) return text;
  const marker = PENDING_MARKERS.find((m) => text.includes(m)) ?? null;
  const idx = marker !== null ? text.indexOf(marker) : -1;

  if (idx === -1 || !marker) {
    const procIdx = PROCESSED_MARKERS.reduce((found, m) => {
      const i = text.indexOf(m);
      return found === -1 || (i !== -1 && i < found) ? i : found;
    }, -1);
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n## Pending\n\n` + formattedLines.join("\n") + "\n\n";
    return text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf("\n## ", afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const prefix = text.slice(0, insertAt);
    const block = (prefix.endsWith("\n") ? "" : "\n") + formattedLines.join("\n") + "\n";
    return prefix + block + text.slice(insertAt);
  }
}

function isValidHttpUrl(str: string): boolean {
  if (typeof str !== "string" || !str.trim()) return false;
  if (/[\s\r\n\t]/.test(str)) return false;
  try {
    const u = new URL(str);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

function sanitizeMarkdownField(val: string): string {
  return String(val ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\[\]\\]/g, (c) => `\\${c}`)
    .replace(/\|/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizePipelineUrl(val: string): string {
  return String(val ?? "")
    .trim()
    .split(/\s+/)[0]
    .replace(/[\[\]\\]/g, (c) => `\\${c}`)
    .replace(/\|/g, "%7C");
}

export async function POST(req: Request) {
  // Auth check
  const secret = process.env.CAREER_OPS_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || !timingSafeCompare(match[1].trim(), secret)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // Body parsing and validation
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid payload: jobs array required" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || !Array.isArray(body.jobs)) {
    return Response.json({ ok: false, error: "Invalid payload: jobs array required" }, { status: 400 });
  }

  const rawJobs = body.jobs;
  if (rawJobs.length > MAX_JOBS_PER_REQUEST) {
    return Response.json(
      { ok: false, error: `Too many jobs: max ${MAX_JOBS_PER_REQUEST} per request` },
      { status: 413 },
    );
  }
  if (rawJobs.length === 0) {
    return Response.json({ ok: true, received: 0, added: 0, skippedDuplicates: 0 });
  }
  const validJobs: CleanJob[] = [];
  for (const job of rawJobs) {
    if (!job || typeof job !== "object") {
      return Response.json({ ok: false, error: "Invalid job entry: valid url, company, and role/title required" }, { status: 400 });
    }
    const url = typeof job.url === "string" ? job.url.trim() : "";
    const company = typeof job.company === "string" ? job.company.trim() : "";
    const rawRole = (typeof job.role === "string" && job.role.trim())
      ? job.role
      : (typeof job.title === "string" && job.title.trim() ? job.title : "");
    const role = rawRole.trim();
    if (!isValidHttpUrl(url) || !company || !role) {
      return Response.json({ ok: false, error: "Invalid job entry: valid url, company, and role/title required" }, { status: 400 });
    }
    const location = typeof job.location === "string" && job.location.trim() ? job.location.trim() : undefined;
    const compensation = typeof (job.compensation || job.salary) === "string" && (job.compensation || job.salary).trim()
      ? (job.compensation || job.salary).trim()
      : undefined;

    validJobs.push({ url, company, role, location, compensation });
  }

  // Resolve target paths
  const dataRoot = getDataRoot();
  const pipelinePath = process.env.CAREER_OPS_PIPELINE?.trim() || path.join(dataRoot, "data", "pipeline.md");
  const trackerEnv = process.env.CAREER_OPS_TRACKER?.trim();
  const applicationsPath = trackerEnv || (fs.existsSync(path.join(dataRoot, "data", "applications.md"))
    ? path.join(dataRoot, "data", "applications.md")
    : path.join(dataRoot, "applications.md"));
  const scanHistoryPath = process.env.CAREER_OPS_SCAN_HISTORY?.trim() || path.join(dataRoot, "data", "scan-history.tsv");

  try {
    return await withPipelineLock(pipelinePath, async () => {
      // 1. Collect seen URLs from pipeline.md, applications.md, scan-history.tsv
      const seenUrls = new Set<string>();

      if (fs.existsSync(pipelinePath)) {
        const pipelineText = fs.readFileSync(pipelinePath, "utf8");
        const urls = pipelineText.match(/https?:\/\/[^\s|)\]>"']+/g) || [];
        for (const u of urls) {
          const norm = normalizeUrl(u);
          if (norm) seenUrls.add(norm);
        }
      }

      if (fs.existsSync(applicationsPath)) {
        const appsText = fs.readFileSync(applicationsPath, "utf8");
        const urls = appsText.match(/https?:\/\/[^\s|)\]>"']+/g) || [];
        for (const u of urls) {
          const norm = normalizeUrl(u);
          if (norm) seenUrls.add(norm);
        }
      }

      if (fs.existsSync(scanHistoryPath)) {
        const histText = fs.readFileSync(scanHistoryPath, "utf8");
        const lines = histText.split("\n").slice(1);
        for (const line of lines) {
          const [u] = line.split("\t");
          if (u) {
            const norm = normalizeUrl(u);
            if (norm) seenUrls.add(norm);
          }
        }
      }

      // 2. Filter out duplicates
      const newJobs: CleanJob[] = [];
      let skippedDuplicates = 0;

      for (const job of validJobs) {
        const norm = normalizeUrl(job.url);
        if (!norm || seenUrls.has(norm)) {
          skippedDuplicates++;
        } else {
          seenUrls.add(norm);
          newJobs.push(job);
        }
      }

      // 3. Write results if any new jobs
      if (newJobs.length > 0) {
        const formattedLines = newJobs.map((j) => {
          const u = sanitizePipelineUrl(j.url);
          const comp = sanitizeMarkdownField(j.company);
          const r = sanitizeMarkdownField(j.role);
          const loc = j.location ? sanitizeMarkdownField(j.location) : "";
          const sal = j.compensation ? sanitizeMarkdownField(j.compensation) : "";
          if (sal) {
            return loc
              ? `- [ ] ${u} | ${comp} | ${r} | ${loc} | ${sal}`
              : `- [ ] ${u} | ${comp} | ${r} | | ${sal}`;
          }
          if (loc) {
            return `- [ ] ${u} | ${comp} | ${r} | ${loc}`;
          }
          return `- [ ] ${u} | ${comp} | ${r}`;
        });

        let currentPipelineText = PIPELINE_SKELETON;
        if (fs.existsSync(pipelinePath)) {
          currentPipelineText = fs.readFileSync(pipelinePath, "utf8");
        }
        const updatedPipelineText = insertPendingOffers(currentPipelineText, formattedLines);
        atomicWrite(pipelinePath, updatedPipelineText);

        // Append to scan-history.tsv
        const date = getLocalToday();
        const source = (typeof body.source === "string" && body.source.trim()) ? body.source.trim() : "mac-scanner";
        fs.mkdirSync(path.dirname(scanHistoryPath), { recursive: true });
        if (!fs.existsSync(scanHistoryPath)) {
          atomicWrite(
            scanHistoryPath,
            "url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\tnormalized_company\n",
          );
        }
        const historyRows = newJobs.map((j) => [
          sanitizePipelineUrl(j.url),
          date,
          source,
          j.role,
          j.company,
          "added",
          j.location || "",
          "",
          "",
          "",
          "",
          normalizeCompanyName(j.company),
        ].map((s) => String(s ?? "").replace(/[\t\r\n]/g, " ").trim()).join("\t")).join("\n") + "\n";

        fs.appendFileSync(scanHistoryPath, historyRows, "utf8");
      }

      return Response.json({
        ok: true,
        received: validJobs.length,
        added: newJobs.length,
        skippedDuplicates,
      });
    });
  } catch (err: any) {
    if (
      err instanceof PipelineBusyError ||
      err?.name === "PipelineBusyError" ||
      err?.name === "LockTimeoutError" ||
      err?.code === "LOCK_TIMEOUT"
    ) {
      return Response.json({ ok: false, error: "Pipeline lock busy: try again later" }, { status: 409 });
    }
    throw err;
  }
}
