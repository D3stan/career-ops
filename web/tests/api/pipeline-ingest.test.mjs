import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { POST } from "../../src/app/api/pipeline/ingest/route.ts";

let tempDir = "";
const savedEnv = { ...process.env };
const TEST_SECRET = "test-webhook-secret-xyz123";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-ingest-test-"));
  process.env.CAREER_OPS_ROOT = tempDir;
  process.env.CAREER_OPS_WEBHOOK_SECRET = TEST_SECRET;
  delete process.env.CAREER_OPS_PIPELINE;
  delete process.env.CAREER_OPS_TRACKER;
  delete process.env.CAREER_OPS_SCAN_HISTORY;
});

afterEach(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  process.env = { ...savedEnv };
});

function makeRequest(body, options = {}) {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");

  if (options.auth !== false) {
    const token = options.token ?? TEST_SECRET;
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      if (v === null) headers.delete(k);
      else headers.set(k, v);
    }
  }

  const rawBody = typeof body === "string" ? body : JSON.stringify(body);

  return new Request("http://localhost/api/pipeline/ingest", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

test("401 when Authorization header is missing", async () => {
  const req = makeRequest({ jobs: [] }, { auth: false });
  const res = await POST(req);
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.deepEqual(data, { ok: false, error: "Unauthorized" });
});

test("401 when Authorization Bearer token is invalid", async () => {
  const req = makeRequest({ jobs: [] }, { token: "wrong-secret-token" });
  const res = await POST(req);
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.deepEqual(data, { ok: false, error: "Unauthorized" });
});

test("401 when CAREER_OPS_WEBHOOK_SECRET is not set in env", async () => {
  delete process.env.CAREER_OPS_WEBHOOK_SECRET;
  const req = makeRequest({ jobs: [] }, { token: TEST_SECRET });
  const res = await POST(req);
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.deepEqual(data, { ok: false, error: "Unauthorized" });
});

test("400 when payload is invalid JSON or jobs array is missing", async () => {
  // Invalid JSON
  const invalidJsonReq = makeRequest("not a json string at all {");
  const res1 = await POST(invalidJsonReq);
  assert.equal(res1.status, 400);
  const data1 = await res1.json();
  assert.deepEqual(data1, { ok: false, error: "Invalid payload: jobs array required" });

  // Missing jobs array
  const missingJobsReq = makeRequest({ source: "mac-scanner" });
  const res2 = await POST(missingJobsReq);
  assert.equal(res2.status, 400);
  const data2 = await res2.json();
  assert.deepEqual(data2, { ok: false, error: "Invalid payload: jobs array required" });

  // jobs is not an array
  const notArrayReq = makeRequest({ jobs: "just a string" });
  const res3 = await POST(notArrayReq);
  assert.equal(res3.status, 400);
  const data3 = await res3.json();
  assert.deepEqual(data3, { ok: false, error: "Invalid payload: jobs array required" });
});

test("200 with added: 0, skippedDuplicates: 0 on empty jobs array", async () => {
  const req = makeRequest({ jobs: [] });
  const res = await POST(req);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, { ok: true, received: 0, added: 0, skippedDuplicates: 0 });
});

test("200 with successful append under ## Pending in data/pipeline.md", async () => {
  const payload = {
    source: "mac-scanner",
    jobs: [
      {
        url: "https://boards.greenhouse.io/acme/jobs/123",
        company: "Acme Corp",
        role: "Staff Software Engineer",
        location: "Remote - Europe",
        compensation: "120k-140k EUR",
      },
    ],
  };

  const req = makeRequest(payload);
  const res = await POST(req);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, { ok: true, received: 1, added: 1, skippedDuplicates: 0 });

  const pipelineFile = path.join(tempDir, "data", "pipeline.md");
  assert.ok(fs.existsSync(pipelineFile), "data/pipeline.md must be created");
  const content = fs.readFileSync(pipelineFile, "utf8");

  assert.ok(content.includes("## Pending"));
  assert.ok(content.includes("## Processed"));

  const pendingIndex = content.indexOf("## Pending");
  const processedIndex = content.indexOf("## Processed");
  const jobLine = "- [ ] https://boards.greenhouse.io/acme/jobs/123 | Acme Corp | Staff Software Engineer | Remote - Europe | 120k-140k EUR";

  assert.ok(content.includes(jobLine), "Line formatted canonically in pipeline.md");
  const jobIndex = content.indexOf(jobLine);
  assert.ok(jobIndex > pendingIndex, "Job is located after ## Pending");
  assert.ok(jobIndex < processedIndex, "Job is located before ## Processed");
});

test("URL format verification in data/pipeline.md (handling optional location and compensation)", async () => {
  const payload = {
    source: "mac-scanner",
    jobs: [
      {
        url: "https://example.com/job/both",
        company: "Company Both",
        role: "Role 1",
        location: "Remote",
        compensation: "100k USD",
      },
      {
        url: "https://example.com/job/comp-only",
        company: "Company CompOnly",
        role: "Role 2",
        compensation: "90k EUR",
      },
      {
        url: "https://example.com/job/loc-only",
        company: "Company LocOnly",
        role: "Role 3",
        location: "Berlin, Germany",
      },
      {
        url: "https://example.com/job/neither",
        company: "Company Neither",
        title: "Role 4", // accept "title" as well
      },
    ],
  };

  const req = makeRequest(payload);
  const res = await POST(req);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, { ok: true, received: 4, added: 4, skippedDuplicates: 0 });

  const pipelineFile = path.join(tempDir, "data", "pipeline.md");
  const content = fs.readFileSync(pipelineFile, "utf8");

  // Both location & compensation present:
  assert.ok(content.includes("- [ ] https://example.com/job/both | Company Both | Role 1 | Remote | 100k USD"));

  // Compensation present, location absent: format as `- [ ] {url} | {company} | {role} | | {compensation}`
  assert.ok(content.includes("- [ ] https://example.com/job/comp-only | Company CompOnly | Role 2 | | 90k EUR"));

  // Location present, compensation absent:
  assert.ok(content.includes("- [ ] https://example.com/job/loc-only | Company LocOnly | Role 3 | Berlin, Germany"));

  // Neither present:
  assert.ok(content.includes("- [ ] https://example.com/job/neither | Company Neither | Role 4"));
});

test("Deduplication: sending already existing URL (in pipeline.md or applications.md) skips it and returns added: 0, skippedDuplicates: 1", async () => {
  const pipelineDir = path.join(tempDir, "data");
  fs.mkdirSync(pipelineDir, { recursive: true });
  const pipelineFile = path.join(pipelineDir, "pipeline.md");
  fs.writeFileSync(
    pipelineFile,
    `# Pipeline\n\n## Pending\n- [ ] https://example.com/jobs/pipeline-job | Acme | Engineer\n\n## Processed\n- [x] https://example.com/jobs/processed-job | Beta | Lead\n`,
  );

  const applicationsFile = path.join(pipelineDir, "applications.md");
  fs.writeFileSync(
    applicationsFile,
    `| # | Company | Role | Status | Date | Link |\n|---|---|---|---|---|---|\n| 001 | Gamma | Architect | Applied | 2026-09-01 | [link](https://example.com/jobs/applied-job) |\n`,
  );

  // 1. Try ingesting job already in pipeline Pending (with tracking query param to test normalization)
  const req1 = makeRequest({
    jobs: [
      {
        url: "https://example.com/jobs/pipeline-job?utm_source=linkedin&utm_medium=feed",
        company: "Acme",
        role: "Engineer",
      },
    ],
  });
  const res1 = await POST(req1);
  assert.equal(res1.status, 200);
  const data1 = await res1.json();
  assert.deepEqual(data1, { ok: true, received: 1, added: 0, skippedDuplicates: 1 });

  // 2. Try ingesting job already in pipeline Processed (with trailing slash)
  const req2 = makeRequest({
    jobs: [
      {
        url: "https://example.com/jobs/processed-job/",
        company: "Beta",
        role: "Lead",
      },
    ],
  });
  const res2 = await POST(req2);
  assert.equal(res2.status, 200);
  const data2 = await res2.json();
  assert.deepEqual(data2, { ok: true, received: 1, added: 0, skippedDuplicates: 1 });

  // 3. Try ingesting job already in applications.md
  const req3 = makeRequest({
    jobs: [
      {
        url: "https://example.com/jobs/applied-job",
        company: "Gamma",
        role: "Architect",
      },
    ],
  });
  const res3 = await POST(req3);
  assert.equal(res3.status, 200);
  const data3 = await res3.json();
  assert.deepEqual(data3, { ok: true, received: 1, added: 0, skippedDuplicates: 1 });

  // 4. Try batch with 1 existing and 1 new
  const req4 = makeRequest({
    jobs: [
      {
        url: "https://example.com/jobs/pipeline-job",
        company: "Acme",
        role: "Engineer",
      },
      {
        url: "https://example.com/jobs/brand-new-job",
        company: "Delta",
        role: "Developer",
      },
    ],
  });
  const res4 = await POST(req4);
  assert.equal(res4.status, 200);
  const data4 = await res4.json();
  assert.deepEqual(data4, { ok: true, received: 2, added: 1, skippedDuplicates: 1 });
});

test("Verify scan-history.tsv receives the new entries", async () => {
  const payload = {
    source: "mac-scanner",
    jobs: [
      {
        url: "https://example.com/jobs/scan-test-1",
        company: "Acme Technologies Inc.",
        role: "DevOps Engineer",
        location: "London, UK",
      },
    ],
  };

  const req = makeRequest(payload);
  const res = await POST(req);
  assert.equal(res.status, 200);

  const scanHistoryFile = path.join(tempDir, "data", "scan-history.tsv");
  assert.ok(fs.existsSync(scanHistoryFile), "data/scan-history.tsv must be created");

  const tsvContent = fs.readFileSync(scanHistoryFile, "utf8");
  const lines = tsvContent.trim().split("\n");

  assert.ok(lines.length >= 2, "Header + at least 1 row");
  assert.equal(
    lines[0],
    "url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\tnormalized_company",
  );

  const row = lines[1].split("\t");
  assert.equal(row[0], "https://example.com/jobs/scan-test-1");
  // first_seen should be YYYY-MM-DD
  assert.match(row[1], /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(row[2], "mac-scanner");
  assert.equal(row[3], "DevOps Engineer");
  assert.equal(row[4], "Acme Technologies Inc.");
  assert.equal(row[5], "added");
  assert.equal(row[6], "London, UK");
  assert.equal(row[11], "acme technologies");
});

test("push-pipeline.mjs parses markdown pipeline checkboxes and pushes to endpoint", async () => {
  const { parseInputContent, pushJobs } = await import("../../../scripts/push-pipeline.mjs");

  const mdInput = `
# Pipeline
## Pending
- [ ] https://example.com/client-push/1 | Client Push Co | Cloud Architect | Remote | 150k
- [ ] https://example.com/client-push/2 | Second Co | Senior Dev | Berlin
`;

  const jobs = parseInputContent(mdInput);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0], {
    url: "https://example.com/client-push/1",
    company: "Client Push Co",
    role: "Cloud Architect",
    location: "Remote",
    compensation: "150k",
  });

  const customFetch = async (url, init) => {
    const webReq = new Request(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    return await POST(webReq);
  };

  const result = await pushJobs({
    remote: "http://remote-vps.internal",
    token: TEST_SECRET,
    source: "mac-scanner",
    jobs,
    fetchFn: customFetch,
  });

  assert.deepEqual(result, { ok: true, received: 2, added: 2, skippedDuplicates: 0 });

  const pipelineFile = path.join(tempDir, "data", "pipeline.md");
  const content = fs.readFileSync(pipelineFile, "utf8");
  assert.ok(content.includes("- [ ] https://example.com/client-push/1 | Client Push Co | Cloud Architect | Remote | 150k"));
  assert.ok(content.includes("- [ ] https://example.com/client-push/2 | Second Co | Senior Dev | Berlin"));
});

test("push-pipeline.mjs parses JSON input and handles auth rejection", async () => {
  const { parseInputContent, pushJobs } = await import("../../../scripts/push-pipeline.mjs");

  const jsonInput = JSON.stringify([
    {
      url: "https://example.com/json/1",
      company: "JSON Co",
      role: "Backend Engineer",
    },
  ]);

  const jobs = parseInputContent(jsonInput);
  assert.equal(jobs.length, 1);

  const customFetch = async (url, init) => {
    const webReq = new Request(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    return await POST(webReq);
  };

  // With wrong token:
  await assert.rejects(
    async () => {
      await pushJobs({
        remote: "http://remote-vps.internal",
        token: "wrong-token",
        jobs,
        fetchFn: customFetch,
      });
    },
    /Remote ingestion error \(401\)/,
  );

  // With correct token:
  const result = await pushJobs({
    remote: "http://remote-vps.internal",
    token: TEST_SECRET,
    jobs,
    fetchFn: customFetch,
  });
  assert.deepEqual(result, { ok: true, received: 1, added: 1, skippedDuplicates: 0 });
});

