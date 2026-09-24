import { NextRequest } from "next/server";
import fs from "node:fs";
import { rootScript } from "@/lib/career-ops";
import { cancelScanJob, getScanJob, startScanJob } from "@/lib/core/scan-job";
import { parseExplorePatch, DEFAULT_FILTERS } from "@/lib/explore";
import { scannerMissingBody, SCANNER_MISSING_STATUS } from "@/lib/explore-error.mjs";

// Background Discover (see lib/core/scan-job.ts): POST starts one detached full
// scan, GET reports it, DELETE cancels it. Free — the scanner makes no LLM calls.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(getScanJob());
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* empty body → defaults */
  }
  if (!fs.existsSync(rootScript("scan-ats-full"))) {
    return Response.json(scannerMissingBody(), { status: SCANNER_MISSING_STATUS });
  }
  try {
    return Response.json(startScanJob(parseExplorePatch(body, DEFAULT_FILTERS)));
  } catch (e) {
    return Response.json({ status: "failed", error: e instanceof Error ? e.message : "could not start the scan" }, { status: 500 });
  }
}

export async function DELETE() {
  return Response.json(cancelScanJob());
}
