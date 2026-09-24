import { spawn } from "node:child_process";
import fs from "node:fs";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";

// Undo a title-sieve drop. The core does the reversal (sieve log, scan history,
// pipeline) — this route only forwards the URL to `title-sieve.mjs --restore`.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let url = "";
  try {
    url = String(((await req.json()) as { url?: unknown }).url ?? "").trim();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  if (!/^https?:\/\//i.test(url)) return Response.json({ error: "url required" }, { status: 400 });
  const script = rootScript("title-sieve");
  if (!fs.existsSync(script)) return Response.json({ error: "This checkout has no title-sieve.mjs — update career-ops." }, { status: 400 });

  const result = await new Promise<{ restored: boolean; backInPipeline?: boolean; error?: string }>((resolve) => {
    // argv, not a shell string: the URL is passed as one argument, never interpreted.
    const child = spawn(process.execPath, [script, "--restore", url], { cwd: careerOpsRoot(), env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => resolve({ restored: false, error: e.message }));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() || "{}"));
      } catch {
        resolve({ restored: false, error: err.trim() || "restore returned no result" });
      }
    });
  });
  return Response.json(result, { status: result.restored ? 200 : 400 });
}
