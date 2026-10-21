import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { companySlug } from "@/lib/company-slug.mjs";
import {
  parseQuickApply,
  buildTrackerTsv,
  localToday,
  type ParsedQuickApply,
} from "@/lib/quick-apply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(authHeader: string | null, secret: string | undefined): boolean {
  const trimmedSecret = secret?.trim();
  if (!trimmedSecret) return false;
  if (!authHeader) return false;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const token = match[1].trim();
  const tokenBuf = Buffer.from(token);
  const secretBuf = Buffer.from(trimmedSecret);
  if (tokenBuf.length !== secretBuf.length) return false;
  try {
    return crypto.timingSafeEqual(tokenBuf, secretBuf);
  } catch {
    return false;
  }
}

function resolveActiveTrackerPath(root: string): string {
  const env = process.env.CAREER_OPS_TRACKER?.trim();
  if (env) return path.resolve(env);
  const dataPath = path.join(root, "data", "applications.md");
  if (fs.existsSync(dataPath)) return dataPath;
  return path.join(root, "applications.md");
}

function resolveScript(name: string, root: string): string {
  const primary = rootScript(name);
  if (fs.existsSync(primary)) return primary;
  const parent = path.resolve(process.cwd(), "..", `${name}.mjs`);
  if (fs.existsSync(parent)) return parent;
  const cwd = path.resolve(process.cwd(), `${name}.mjs`);
  if (fs.existsSync(cwd)) return cwd;
  return primary;
}

function runScript(
  scriptName: string,
  rootDir: string,
  args: string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    const scriptPath = resolveScript(scriptName, rootDir);
    try {
      child = spawn(process.execPath, [scriptPath, ...args], {
        cwd: rootDir,
        env: process.env,
      });
    } catch (e: any) {
      resolve({ code: 1, stdout: "", stderr: e?.message || `Failed to start ${scriptName}` });
      return;
    }
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const killer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 30_000);
    child.on("error", (e) => {
      clearTimeout(killer);
      resolve({ code: 1, stdout, stderr: stderr + "\n" + e.message });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function POST(req: Request) {
  // 1. Auth check
  const authHeader = req.headers.get("authorization");
  const secret = process.env.CAREER_OPS_WEBHOOK_SECRET;
  if (!isAuthorized(authHeader, secret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Body & URL parsing
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Missing or invalid url" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || !body.url || typeof body.url !== "string") {
    return Response.json({ error: "Missing or invalid url" }, { status: 400 });
  }

  let parsed: ParsedQuickApply;
  try {
    parsed = parseQuickApply(body);
  } catch {
    return Response.json({ error: "Missing or invalid url" }, { status: 400 });
  }

  // 3 & 4. Staging TSV file
  const root = careerOpsRoot();
  const additionsDir =
    process.env.CAREER_OPS_ADDITIONS || path.join(root, "batch", "tracker-additions");
  await fs.promises.mkdir(additionsDir, { recursive: true });

  const { fullTsv } = buildTrackerTsv(parsed);
  const slug = companySlug(parsed.company)?.slug || "unknown";
  const filename = `${Date.now()}-${slug}.tsv`;
  const tsvPath = path.join(additionsDir, filename);
  await fs.promises.writeFile(tsvPath, fullTsv, "utf8");

  // 5. Run merge-tracker.mjs
  const mergeResult = await runScript("merge-tracker", root);
  if (mergeResult.code !== 0) {
    return Response.json(
      { error: "Failed to merge tracker addition", details: mergeResult.stderr },
      { status: 500 },
    );
  }

  // Extract assigned tracker number
  let trackerNum: string | null = null;
  const addMatch = mergeResult.stdout.match(/➕\s*Add\s*#(\d+):/i);
  if (addMatch) {
    trackerNum = addMatch[1];
  } else {
    const updateMatch = mergeResult.stdout.match(/Update\s*#(\d+):/i);
    if (updateMatch) trackerNum = updateMatch[1];
  }

  if (!trackerNum) {
    try {
      const trackerPath = resolveActiveTrackerPath(root);
      if (fs.existsSync(trackerPath)) {
        const content = fs.readFileSync(trackerPath, "utf8");
        for (const line of content.split("\n")) {
          if (!line.startsWith("|")) continue;
          const parts = line.split("|").map((s) => s.trim());
          if (
            parts.some((p) => p === parsed.url) ||
            (parts[3] === parsed.company && parts[4] === parsed.role)
          ) {
            const num = parts[1];
            if (/^\d+$/.test(num)) {
              trackerNum = num;
              break;
            }
          }
        }
      }
    } catch {
      /* best effort */
    }
  }

  // 6. Run followup-seed.mjs
  // Only seed when we know the exact row; never fall back to a tracker-wide run.
  if (trackerNum) {
    await runScript("followup-seed", root, [trackerNum]);
  }

  // 7. Append status change to data/status-log.tsv
  try {
    const trackerPath = resolveActiveTrackerPath(root);
    const statusLogPath = path.join(path.dirname(trackerPath), "status-log.tsv");
    await fs.promises.mkdir(path.dirname(statusLogPath), { recursive: true });
    const today = localToday();
    const logLine = `${trackerNum ?? "-"}\t${today}\t-\tApplied\tweb\t${parsed.notes}\n`;
    await fs.promises.appendFile(statusLogPath, logLine, "utf8");
  } catch (err) {
    console.error("Warning: failed to append to status-log.tsv:", err);
  }

  // 8. Return response
  return Response.json({
    ok: true,
    company: parsed.company,
    role: parsed.role,
    status: "Applied",
  });
}
