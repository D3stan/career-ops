import { test, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { POST } from "../../src/app/api/pipeline/ingest/route.ts";
import { withPipelineLock } from "../../src/lib/core/pipeline-lock.mjs";
import { parseArgs, parseInputContent, pushJobs } from "../../../scripts/push-pipeline.mjs";

let tempDir = "";
const savedEnv = { ...process.env };
const TEST_SECRET = "super-secret-webhook-key-998877";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-verify-test-"));
  process.env.CAREER_OPS_ROOT = tempDir;
  process.env.CAREER_OPS_WEBHOOK_SECRET = TEST_SECRET;
  delete process.env.CAREER_OPS_PIPELINE;
  delete process.env.CAREER_OPS_TRACKER;
  delete process.env.CAREER_OPS_SCAN_HISTORY;
  delete process.env.CAREER_OPS_WEB_PIPELINE_LOCK_TIMEOUT_MS;
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
    if (token !== undefined) {
      const scheme = options.scheme ?? "Bearer";
      headers.set("Authorization", `${scheme} ${token}`.trim());
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

// ─────────────────────────────────────────────────────────────────────────────
// 1. AUTHENTICATION EDGE CASES
// ─────────────────────────────────────────────────────────────────────────────
describe("1. Authentication Edge Cases", () => {
  test("401 when Authorization header is completely missing", async () => {
    const req = makeRequest({ jobs: [] }, { auth: false });
    const res = await POST(req);
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.deepEqual(data, { ok: false, error: "Unauthorized" });
  });

  test("401 for invalid auth schemes (Basic, Token, Custom, Bearer with no token)", async () => {
    // Basic scheme
    const req1 = makeRequest({ jobs: [] }, { scheme: "Basic", token: "dXNlcjpwYXNz" });
    const res1 = await POST(req1);
    assert.equal(res1.status, 401);

    // Token scheme
    const req2 = makeRequest({ jobs: [] }, { scheme: "Token", token: TEST_SECRET });
    const res2 = await POST(req2);
    assert.equal(res2.status, 401);

    // Bearer with no token
    const req3 = new Request("http://localhost/api/pipeline/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer" },
      body: JSON.stringify({ jobs: [] }),
    });
    const res3 = await POST(req3);
    assert.equal(res3.status, 401);

    // Bearer with only whitespace
    const req4 = new Request("http://localhost/api/pipeline/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer    " },
      body: JSON.stringify({ jobs: [] }),
    });
    const res4 = await POST(req4);
    assert.equal(res4.status, 401);
  });

  test("401 when token length differs from secret (safe from timingSafeEqual RangeError)", async () => {
    // Shorter token
    const reqShort = makeRequest({ jobs: [] }, { token: "short" });
    const resShort = await POST(reqShort);
    assert.equal(resShort.status, 401);

    // Longer token
    const reqLong = makeRequest({ jobs: [] }, { token: TEST_SECRET + "-extra-bytes-padding-12345" });
    const resLong = await POST(reqLong);
    assert.equal(resLong.status, 401);

    // Same length, different content
    const wrongSameLen = "x".repeat(TEST_SECRET.length);
    const reqSameLen = makeRequest({ jobs: [] }, { token: wrongSameLen });
    const resSameLen = await POST(reqSameLen);
    assert.equal(resSameLen.status, 401);
  });

  test("401 when CAREER_OPS_WEBHOOK_SECRET is unset, empty string, or whitespace", async () => {
    // Unset
    delete process.env.CAREER_OPS_WEBHOOK_SECRET;
    const req1 = makeRequest({ jobs: [] }, { token: TEST_SECRET });
    const res1 = await POST(req1);
    assert.equal(res1.status, 401);

    // Empty string
    process.env.CAREER_OPS_WEBHOOK_SECRET = "";
    const req2 = makeRequest({ jobs: [] }, { token: TEST_SECRET });
    const res2 = await POST(req2);
    assert.equal(res2.status, 401);

    // Whitespace only
    process.env.CAREER_OPS_WEBHOOK_SECRET = "    ";
    const req3 = makeRequest({ jobs: [] }, { token: TEST_SECRET });
    const res3 = await POST(req3);
    assert.equal(res3.status, 401);
  });

  test("200 when extra whitespace surrounds token in header or secret in env", async () => {
    // Secret in env has whitespace
    process.env.CAREER_OPS_WEBHOOK_SECRET = `  ${TEST_SECRET}   `;

    // Request token has leading/trailing whitespace
    const req = new Request("http://localhost/api/pipeline/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer    ${TEST_SECRET}   `,
      },
      body: JSON.stringify({ jobs: [] }),
    });

    const res = await POST(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PAYLOAD & JOB VALIDATION EDGE CASES
// ─────────────────────────────────────────────────────────────────────────────
describe("2. Payload & Job Validation Edge Cases", () => {
  test("400 for non-JSON or primitive body payloads", async () => {
    // Malformed JSON
    const res1 = await POST(makeRequest("{broken json"));
    assert.equal(res1.status, 400);

    // null body
    const res2 = await POST(makeRequest("null"));
    assert.equal(res2.status, 400);

    // boolean body
    const res3 = await POST(makeRequest("true"));
    assert.equal(res3.status, 400);

    // number body
    const res4 = await POST(makeRequest("12345"));
    assert.equal(res4.status, 400);

    // string body
    const res5 = await POST(makeRequest('"just a string"'));
    assert.equal(res5.status, 400);
  });

  test("400 when jobs field is missing or not an array", async () => {
    // Missing jobs field
    const res1 = await POST(makeRequest({}));
    assert.equal(res1.status, 400);

    const res2 = await POST(makeRequest({ source: "mac-scanner" }));
    assert.equal(res2.status, 400);

    // jobs is not an array
    const res3 = await POST(makeRequest({ jobs: "not-an-array" }));
    assert.equal(res3.status, 400);

    const res4 = await POST(makeRequest({ jobs: 123 }));
    assert.equal(res4.status, 400);

    const res5 = await POST(makeRequest({ jobs: {} }));
    assert.equal(res5.status, 400);
  });

  test("400 when jobs array contains non-object or malformed entries", async () => {
    const invalidEntries = [
      null,
      123,
      "a string",
      {},
      { url: "https://example.com/job" }, // missing company & role
      { company: "Acme", role: "Dev" }, // missing url
      { url: "https://example.com/job", company: "Acme" }, // missing role
      { url: "https://example.com/job", role: "Dev" }, // missing company
      { url: "https://example.com/job", company: "   ", role: "Dev" }, // whitespace company
      { url: "https://example.com/job", company: "Acme", role: "   " }, // whitespace role
    ];

    for (const badEntry of invalidEntries) {
      const res = await POST(makeRequest({ jobs: [badEntry] }));
      assert.equal(res.status, 400, `Expected 400 for entry: ${JSON.stringify(badEntry)}`);
      const data = await res.json();
      assert.equal(data.ok, false);
      assert.equal(data.error, "Invalid job entry: valid url, company, and role/title required");
    }
  });

  test("400 for invalid, non-HTTP, or malformed URLs", async () => {
    const badUrls = [
      "ftp://example.com/job",
      "javascript:alert(1)",
      "not-a-url",
      "https://",
      "http://",
      "https://example.com/job with spaces",
      "https://example.com/job\nwith\nnewlines",
      "data:text/plain;base64,SGVsbG8=",
    ];

    for (const badUrl of badUrls) {
      const res = await POST(
        makeRequest({
          jobs: [{ url: badUrl, company: "Acme", role: "Dev" }],
        }),
      );
      assert.equal(res.status, 400, `Expected 400 for invalid URL: ${badUrl}`);
    }
  });

  test("Accepts title as alias for role, and falls back to title if role is whitespace", async () => {
    const res = await POST(
      makeRequest({
        jobs: [
          {
            url: "https://example.com/job/title-alias",
            company: "Alias Corp",
            title: "Staff Platform Engineer",
          },
          {
            url: "https://example.com/job/role-whitespace-fallback",
            company: "Fallback Corp",
            role: "   ",
            title: "Lead Architect",
          },
        ],
      }),
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.added, 2);

    const pipelineFile = path.join(tempDir, "data", "pipeline.md");
    const content = fs.readFileSync(pipelineFile, "utf8");
    assert.ok(content.includes("Staff Platform Engineer"));
    assert.ok(content.includes("Lead Architect"));
  });

  test("Sanitizes markdown pipes, brackets, and newlines in company/role/location/comp", async () => {
    const res = await POST(
      makeRequest({
        jobs: [
          {
            url: "https://example.com/job/pipes-and-newlines?filter=a|b",
            company: "Acme | AI\nDivision [EMEA]",
            role: "Senior AI | ML\nEngineer [Core]",
            location: "Berlin | Remote\nGermany",
            compensation: "120k | 140k\nEUR",
          },
        ],
      }),
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.added, 1);

    const pipelineFile = path.join(tempDir, "data", "pipeline.md");
    const content = fs.readFileSync(pipelineFile, "utf8");

    // The line in pipeline.md MUST be a single line (no rogue newlines breaking the checkbox)
    const lines = content.split("\n").filter((l) => l.includes("https://example.com/job/pipes-and-newlines"));
    assert.equal(lines.length, 1, "Must produce exactly 1 line in pipeline.md");

    const line = lines[0];
    // Brackets must be escaped
    assert.ok(line.includes("\\[EMEA\\]"), "Brackets escaped in company");
    assert.ok(line.includes("\\[Core\\]"), "Brackets escaped in role");
    // Newlines replaced with spaces
    assert.ok(line.includes("AI Division"), "Newlines replaced in company");
    assert.ok(line.includes("ML Engineer"), "Newlines replaced in role");
    assert.ok(line.includes("Berlin / Remote Germany"), "Location sanitized");
    assert.ok(line.includes("120k / 140k EUR"), "Compensation sanitized");
    // URL pipe escaped as %7C
    assert.ok(line.includes("filter=a%7Cb"), "URL pipe encoded as %7C");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DUPLICATE HANDLING & IN-BATCH DUPLICATES
// ─────────────────────────────────────────────────────────────────────────────
describe("3. Duplicate Handling & In-Batch Duplicates", () => {
  test("Filters duplicate URLs WITHIN THE SAME INCOMING BATCH", async () => {
    const res = await POST(
      makeRequest({
        jobs: [
          {
            url: "https://example.com/batch-job/1",
            company: "Batch Co",
            role: "Dev",
          },
          {
            // Exact same URL
            url: "https://example.com/batch-job/1",
            company: "Batch Co Duplicate",
            role: "Dev Duplicate",
          },
          {
            // Same URL with tracking query params
            url: "https://example.com/batch-job/1?utm_source=linkedin&utm_campaign=hiring",
            company: "Batch Co Tracking",
            role: "Dev Tracking",
          },
          {
            // Same URL with trailing slash and uppercase host
            url: "https://EXAMPLE.COM/batch-job/1/",
            company: "Batch Co Case",
            role: "Dev Case",
          },
          {
            // Distinct URL
            url: "https://example.com/batch-job/2",
            company: "Batch Co 2",
            role: "Dev 2",
          },
        ],
      }),
    );

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.received, 5);
    assert.equal(data.added, 2, "Only the 2 unique URLs should be added");
    assert.equal(data.skippedDuplicates, 3, "The 3 duplicate variations should be skipped");

    const pipelineFile = path.join(tempDir, "data", "pipeline.md");
    const content = fs.readFileSync(pipelineFile, "utf8");
    const matches1 = (content.match(/https:\/\/example\.com\/batch-job\/1/g) || []).length;
    assert.equal(matches1, 1, "Only one instance of job 1 should be written to pipeline.md");
  });

  test("Deduplicates against scan-history.tsv entries", async () => {
    const scanHistoryDir = path.join(tempDir, "data");
    fs.mkdirSync(scanHistoryDir, { recursive: true });
    const scanHistoryFile = path.join(scanHistoryDir, "scan-history.tsv");

    fs.writeFileSync(
      scanHistoryFile,
      "url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\tnormalized_company\n" +
        "https://example.com/jobs/already-scanned\t2026-10-01\tmac-scanner\tEngineer\tHistory Co\tadded\tRemote\t\t\t\t\thistory co\n",
    );

    const res = await POST(
      makeRequest({
        jobs: [
          {
            url: "https://example.com/jobs/already-scanned?utm_source=newsletter",
            company: "History Co",
            role: "Engineer",
          },
        ],
      }),
    );

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.received, 1);
    assert.equal(data.added, 0);
    assert.equal(data.skippedDuplicates, 1);
  });

  test("Deduplicates against both Pending and Processed sections in pipeline.md", async () => {
    const pipelineDir = path.join(tempDir, "data");
    fs.mkdirSync(pipelineDir, { recursive: true });
    const pipelineFile = path.join(pipelineDir, "pipeline.md");

    fs.writeFileSync(
      pipelineFile,
      `# Pipeline\n\n## Pending\n- [ ] https://example.com/jobs/pending-1 | Co1 | R1\n\n## Processed\n- [x] https://example.com/jobs/processed-1 | Co2 | R2\n`,
    );

    const res = await POST(
      makeRequest({
        jobs: [
          { url: "https://example.com/jobs/pending-1/", company: "Co1", role: "R1" },
          { url: "https://example.com/jobs/processed-1?gh_src=share", company: "Co2", role: "R2" },
          { url: "https://example.com/jobs/fresh-1", company: "Co3", role: "R3" },
        ],
      }),
    );

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.received, 3);
    assert.equal(data.added, 1);
    assert.equal(data.skippedDuplicates, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. CONCURRENT LOCK HANDLING
// ─────────────────────────────────────────────────────────────────────────────
describe("4. Concurrent Lock Handling", () => {
  test("Concurrent requests serialize safely without losing data or corrupting pipeline.md", async () => {
    const CONCURRENCY = 8;
    const promises = [];

    for (let i = 0; i < CONCURRENCY; i++) {
      const payload = {
        source: `worker-${i}`,
        jobs: [
          {
            url: `https://example.com/concurrent-job/${i}`,
            company: `Concurrent Co ${i}`,
            role: `Concurrency Tester ${i}`,
          },
        ],
      };
      promises.push(POST(makeRequest(payload)));
    }

    const results = await Promise.all(promises);
    for (const res of results) {
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.added, 1);
    }

    const pipelineFile = path.join(tempDir, "data", "pipeline.md");
    assert.ok(fs.existsSync(pipelineFile));
    const content = fs.readFileSync(pipelineFile, "utf8");

    // Verify every single concurrent job was written
    for (let i = 0; i < CONCURRENCY; i++) {
      assert.ok(
        content.includes(`https://example.com/concurrent-job/${i}`),
        `Job ${i} must be present in pipeline.md`,
      );
    }

    // Verify lock directory is completely released
    const lockDir = `${pipelineFile}.lock`;
    assert.equal(fs.existsSync(lockDir), false, "Lock directory must not linger after requests finish");
  });

  test("Returns 409 when pipeline lock is held and times out", async () => {
    const pipelineDir = path.join(tempDir, "data");
    fs.mkdirSync(pipelineDir, { recursive: true });
    const pipelineFile = path.join(pipelineDir, "pipeline.md");
    fs.writeFileSync(pipelineFile, "# Pipeline\n\n## Pending\n\n## Processed\n");

    const lockDir = `${pipelineFile}.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: process.pid, token: "external-holder", started_at: new Date().toISOString() }),
    );

    // Set lock timeout to 200ms for fast test execution
    process.env.CAREER_OPS_WEB_PIPELINE_LOCK_TIMEOUT_MS = "200";

    try {
      const req = makeRequest({
        jobs: [{ url: "https://example.com/locked-job", company: "Locked Co", role: "Dev" }],
      });
      const res = await POST(req);
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.deepEqual(data, { ok: false, error: "Pipeline lock busy: try again later" });
    } finally {
      // Clean up manual lock
      fs.rmSync(lockDir, { recursive: true, force: true });
      delete process.env.CAREER_OPS_WEB_PIPELINE_LOCK_TIMEOUT_MS;
    }

    // Now request should succeed
    const reqAfter = makeRequest({
      jobs: [{ url: "https://example.com/locked-job", company: "Locked Co", role: "Dev" }],
    });
    const resAfter = await POST(reqAfter);
    assert.equal(resAfter.status, 200);
    const dataAfter = await resAfter.json();
    assert.equal(dataAfter.added, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DATA CONTRACT & STRUCTURAL INTEGRITY
// ─────────────────────────────────────────────────────────────────────────────
describe("5. Data Contract & Structural Integrity", () => {
  test("Only data/pipeline.md and data/scan-history.tsv are created/modified", async () => {
    const res = await POST(
      makeRequest({
        jobs: [{ url: "https://example.com/integrity/1", company: "Integrity Co", role: "Auditor" }],
      }),
    );
    assert.equal(res.status, 200);

    const dataFiles = fs.readdirSync(path.join(tempDir, "data")).sort();
    assert.deepEqual(dataFiles, ["pipeline.md", "scan-history.tsv"]);
  });

  test("Existing preamble, comments, and Spanish markers are preserved without loss", async () => {
    const pipelineDir = path.join(tempDir, "data");
    fs.mkdirSync(pipelineDir, { recursive: true });
    const pipelineFile = path.join(pipelineDir, "pipeline.md");

    const originalContent = `# Mi Pipeline Personalizado

<!-- Comentario inicial importante que nunca debe borrarse -->

## Pendientes

<!-- Notas sobre ofertas en evaluacion -->
- [ ] https://example.com/existing-job | Empresa Existente | Rol Existente

## Procesadas

<!-- Ofertas finalizadas -->
- [x] https://example.com/old-job | Empresa Vieja | Rol Viejo
`;

    fs.writeFileSync(pipelineFile, originalContent);

    const res = await POST(
      makeRequest({
        jobs: [{ url: "https://example.com/new-spanish-job", company: "Empresa Nueva", role: "Rol Nuevo" }],
      }),
    );
    assert.equal(res.status, 200);

    const newContent = fs.readFileSync(pipelineFile, "utf8");
    assert.ok(newContent.includes("# Mi Pipeline Personalizado"));
    assert.ok(newContent.includes("<!-- Comentario inicial importante que nunca debe borrarse -->"));
    assert.ok(newContent.includes("## Pendientes"));
    assert.ok(newContent.includes("<!-- Notas sobre ofertas en evaluacion -->"));
    assert.ok(newContent.includes("- [ ] https://example.com/existing-job | Empresa Existente | Rol Existente"));
    assert.ok(newContent.includes("- [ ] https://example.com/new-spanish-job | Empresa Nueva | Rol Nuevo"));
    assert.ok(newContent.includes("## Procesadas"));
    assert.ok(newContent.includes("<!-- Ofertas finalizadas -->"));
    assert.ok(newContent.includes("- [x] https://example.com/old-job | Empresa Vieja | Rol Viejo"));
  });

  test("Canonical line formats: 5-col, 4-col with empty loc, 4-col with loc, 3-col", async () => {
    const res = await POST(
      makeRequest({
        jobs: [
          {
            url: "https://example.com/fmt/5col",
            company: "Co 5",
            role: "Role 5",
            location: "Remote",
            compensation: "150k",
          },
          {
            url: "https://example.com/fmt/4col-comp-only",
            company: "Co 4Comp",
            role: "Role 4Comp",
            compensation: "120k",
          },
          {
            url: "https://example.com/fmt/4col-loc-only",
            company: "Co 4Loc",
            role: "Role 4Loc",
            location: "Zurich",
          },
          {
            url: "https://example.com/fmt/3col",
            company: "Co 3",
            role: "Role 3",
          },
        ],
      }),
    );
    assert.equal(res.status, 200);

    const pipelineFile = path.join(tempDir, "data", "pipeline.md");
    const content = fs.readFileSync(pipelineFile, "utf8");

    assert.ok(content.includes("- [ ] https://example.com/fmt/5col | Co 5 | Role 5 | Remote | 150k"));
    assert.ok(content.includes("- [ ] https://example.com/fmt/4col-comp-only | Co 4Comp | Role 4Comp | | 120k"));
    assert.ok(content.includes("- [ ] https://example.com/fmt/4col-loc-only | Co 4Loc | Role 4Loc | Zurich"));
    assert.ok(content.includes("- [ ] https://example.com/fmt/3col | Co 3 | Role 3"));
    // Ensure no trailing pipe on 3-col
    assert.ok(!content.includes("- [ ] https://example.com/fmt/3col | Co 3 | Role 3 |"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. CLIENT TOOLS VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────
describe("6. Client Tools Verification (push-pipeline.mjs & scan.mjs)", () => {
  test("push-pipeline.mjs: parseArgs supports --remote, --token, --file, --source with spaces and equals", () => {
    const args1 = ["--remote", "https://vps.example.com", "--token", "secret1", "--file", "jobs.md", "--source", "custom-source"];
    const parsed1 = parseArgs(args1);
    assert.equal(parsed1.remote, "https://vps.example.com");
    assert.equal(parsed1.token, "secret1");
    assert.equal(parsed1.file, "jobs.md");
    assert.equal(parsed1.source, "custom-source");

    const args2 = ["--remote=https://vps2.example.com", "--token=secret2", "--file=jobs.json", "--source=s2"];
    const parsed2 = parseArgs(args2);
    assert.equal(parsed2.remote, "https://vps2.example.com");
    assert.equal(parsed2.token, "secret2");
    assert.equal(parsed2.file, "jobs.json");
    assert.equal(parsed2.source, "s2");
  });

  test("push-pipeline.mjs: parseInputContent handles JSON and Markdown pipeline formats", () => {
    // JSON array
    const jsonArr = JSON.stringify([{ url: "https://example.com/1", company: "C1", role: "R1" }]);
    assert.equal(parseInputContent(jsonArr).length, 1);

    // JSON object with jobs
    const jsonObj = JSON.stringify({ jobs: [{ url: "https://example.com/2", company: "C2", role: "R2" }] });
    assert.equal(parseInputContent(jsonObj).length, 1);

    // Markdown pipeline with various column formats & labeled segments
    const md = `
# Pipeline
## Pending
- [ ] https://example.com/md/1 | Comp 1 | Lead | Remote | 180k
- [ ] https://example.com/md/2 | Comp 2 | Architect | | 200k
- [ ] https://example.com/md/3 | Comp 3 | Senior | London | posted: 2026-10-10 | trust: 90 | note: awesome
- [ ] https://example.com/md/4 | Comp 4 | Junior
`;
    const jobs = parseInputContent(md);
    assert.equal(jobs.length, 4);

    assert.deepEqual(jobs[0], {
      url: "https://example.com/md/1",
      company: "Comp 1",
      role: "Lead",
      location: "Remote",
      compensation: "180k",
    });

    assert.deepEqual(jobs[1], {
      url: "https://example.com/md/2",
      company: "Comp 2",
      role: "Architect",
      location: undefined,
      compensation: "200k",
    });

    assert.deepEqual(jobs[2], {
      url: "https://example.com/md/3",
      company: "Comp 3",
      role: "Senior",
      location: "London",
      compensation: undefined,
    });

    assert.deepEqual(jobs[3], {
      url: "https://example.com/md/4",
      company: "Comp 4",
      role: "Junior",
      location: undefined,
      compensation: undefined,
    });
  });

  test("push-pipeline.mjs: pushJobs validates remote and token requirements", async () => {
    // Missing remote
    await assert.rejects(
      async () => {
        await pushJobs({ remote: "", token: "secret", jobs: [] });
      },
      /Remote URL missing/,
    );

    // Missing token
    await assert.rejects(
      async () => {
        await pushJobs({ remote: "http://vps", token: "", jobs: [] });
      },
      /Webhook token missing/,
    );
  });

  test("scan.mjs: verifies KNOWN_FLAGS and VALUE_FLAGS include --push, --remote, --token", async () => {
    const { fileURLToPath } = await import("node:url");
    const scanFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scan.mjs");
    const scanText = fs.readFileSync(scanFile, "utf8");

    // Check KNOWN_FLAGS
    assert.ok(scanText.includes("'--push'"), "KNOWN_FLAGS must include '--push'");
    assert.ok(scanText.includes("'--remote'"), "KNOWN_FLAGS must include '--remote'");
    assert.ok(scanText.includes("'--token'"), "KNOWN_FLAGS must include '--token'");

    // Check VALUE_FLAGS
    const valueFlagsMatch = scanText.match(/const VALUE_FLAGS\s*=\s*\[([^\]]+)\]/);
    assert.ok(valueFlagsMatch, "VALUE_FLAGS must be defined in scan.mjs");
    assert.ok(valueFlagsMatch[1].includes("'--remote'"), "VALUE_FLAGS must include '--remote'");
    assert.ok(valueFlagsMatch[1].includes("'--token'"), "VALUE_FLAGS must include '--token'");
  });
});
