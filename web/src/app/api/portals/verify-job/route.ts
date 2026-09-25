import { cancelVerifyJob, getVerifyJob, startVerifyJob, verifyAvailability } from "@/lib/core/verify-job";

// Background "Check portal health" (see lib/core/verify-job.ts for why this
// can't be an in-request call). GET reports current state + availability,
// POST starts one run, DELETE cancels it. Free — no LLM calls.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ...verifyAvailability(), job: getVerifyJob() });
}

export async function POST() {
  return Response.json({ ...verifyAvailability(), job: startVerifyJob() });
}

export async function DELETE() {
  return Response.json({ job: cancelVerifyJob() });
}
