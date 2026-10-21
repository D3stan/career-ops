import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const ALIAS_EXTS = [".ts", ".tsx", ".mjs", ".js", ".mts"];
const loaderSrc = [
  "import { existsSync } from 'node:fs';",
  "import path from 'node:path';",
  "import { pathToFileURL } from 'node:url';",
  `const WEB_SRC = ${JSON.stringify(WEB_SRC)};`,
  `const EXTS = ${JSON.stringify(ALIAS_EXTS)};`,
  "function resolveWithExt(base) {",
  "  for (const ext of EXTS) { if (existsSync(base + ext)) return base + ext; }",
  "  if (existsSync(base)) return base;",
  "  return null;",
  "}",
  "export async function resolve(specifier, context, nextResolve) {",
  "  if (specifier.startsWith('@/')) {",
  "    const rel = specifier.slice(2);",
  "    const base = path.join(WEB_SRC, rel);",
  "    const resolved = resolveWithExt(base);",
  "    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };",
  "  }",
  "  return nextResolve(specifier, context);",
  "}",
].join("\n");
register("data:text/javascript," + encodeURIComponent(loaderSrc), pathToFileURL(WEB_SRC + "/"));

const {
  extractCompanyFromUrl,
  cleanDomain,
  parseTitle,
  parseQuickApply,
  buildTrackerTsv,
} = await import("../../src/lib/quick-apply.ts");

const { POST } = await import("../../src/app/api/tracker/quick-apply/route.ts");
const { checkRequest } = await import("../../src/lib/origin-guard.mjs");

// --- 1. Parsing Helpers Unit Tests ------------------------------------------

test("extractCompanyFromUrl extracts company from Greenhouse URLs", () => {
  assert.equal(
    extractCompanyFromUrl("https://boards.greenhouse.io/stripe/jobs/12345"),
    "stripe",
  );
  assert.equal(
    extractCompanyFromUrl("https://job-boards.greenhouse.io/figma/jobs/67890"),
    "figma",
  );
});

test("extractCompanyFromUrl extracts company from Lever URLs", () => {
  assert.equal(
    extractCompanyFromUrl("https://jobs.lever.co/netflix/abc-123-def"),
    "netflix",
  );
});

test("extractCompanyFromUrl extracts company from Ashby URLs", () => {
  assert.equal(
    extractCompanyFromUrl("https://jobs.ashbyhq.com/openai/112233"),
    "openai",
  );
});

test("extractCompanyFromUrl extracts company from Workday URLs", () => {
  assert.equal(
    extractCompanyFromUrl(
      "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/USA-CA-Santa-Clara/Senior-Engineer_JR123",
    ),
    "nvidia",
  );
  assert.equal(
    extractCompanyFromUrl("https://myworkdayjobs.com/en-US/apple/job/123"),
    "apple",
  );
});

test("extractCompanyFromUrl returns null for unknown hosts or invalid URLs", () => {
  assert.equal(extractCompanyFromUrl("https://example.com/careers/123"), null);
  assert.equal(extractCompanyFromUrl("not-a-url"), null);
});

test("cleanDomain cleans domain name and capitalizes words", () => {
  assert.equal(cleanDomain("careers.acme.com"), "Acme");
  assert.equal(cleanDomain("jobs.stripe.com"), "Stripe");
  assert.equal(cleanDomain("acme-corp.com"), "Acme Corp");
  assert.equal(cleanDomain(""), "Unknown");
});

test("parseTitle extracts role and company with various separators", () => {
  // Title with ATS suffix and hyphen separator
  const t1 = parseTitle("Senior Backend Engineer - Acme | Greenhouse", "acme");
  assert.equal(t1.role, "Senior Backend Engineer");
  assert.equal(t1.company, "Acme");

  // Title with "at" separator
  const t2 = parseTitle("Staff Engineer at Stripe");
  assert.equal(t2.role, "Staff Engineer");
  assert.equal(t2.company, "Stripe");

  // Title with "@" separator
  const t3 = parseTitle("Lead Data Scientist @ Spotify");
  assert.equal(t3.role, "Lead Data Scientist");
  assert.equal(t3.company, "Spotify");

  // Title with pipe separator
  const t4 = parseTitle("Product Designer | Figma");
  assert.equal(t4.role, "Product Designer");
  assert.equal(t4.company, "Figma");

  // Single role without company
  const t5 = parseTitle("Senior Software Engineer");
  assert.equal(t5.role, "Senior Software Engineer");
  assert.equal(t5.company, undefined);
});

test("parseQuickApply resolves fallbacks and user overrides", () => {
  // ATS URL + title with ATS brand suffix
  const p1 = parseQuickApply({
    url: "https://boards.greenhouse.io/acme/jobs/123",
    title: "Senior Backend Engineer - Acme | Greenhouse",
  });
  assert.equal(p1.company, "Acme");
  assert.equal(p1.role, "Senior Backend Engineer");
  assert.equal(p1.via, "Direct");
  assert.equal(p1.notes, "Applied via Quick Apply");

  // Non-ATS URL fallback to domain
  const p2 = parseQuickApply({
    url: "https://acme.org/jobs/42",
  });
  assert.equal(p2.company, "Acme");
  assert.equal(p2.role, "Unknown Role");
  assert.equal(p2.via, "Direct");
  assert.equal(p2.notes, "Applied via Quick Apply");

  // User explicit overrides
  const p3 = parseQuickApply({
    url: "https://acme.org/jobs/42",
    company: "My Company",
    role: "Lead Architect",
    via: "Referral",
    notes: "Referred by Alice",
  });
  assert.equal(p3.company, "My Company");
  assert.equal(p3.role, "Lead Architect");
  assert.equal(p3.via, "Referral");
  assert.equal(p3.notes, "Referred by Alice");
});

test("parseQuickApply throws on malformed or unsupported URLs", () => {
  const malformed = [
    "",
    "   ",
    "ftp://example.com/job/123",
    "javascript:alert(1)",
    "javascript://alert(1)",
    "data:text/plain;base64,SGVsbG8sIFdvcmxkIQ==",
    "not-a-valid-url",
    "http://",
    "https://",
    "//example.com",
    null,
    undefined,
    12345,
  ];

  for (const item of malformed) {
    assert.throws(
      () => parseQuickApply({ url: item }),
      /Missing or invalid url/,
      `Expected "${item}" to throw invalid url`,
    );
  }
});

test("parseQuickApply handles optional fields, nulls, whitespace, and sanitizes tabs/newlines", () => {
  // All nulls / undefined
  const p1 = parseQuickApply({
    url: "https://example.com/jobs/1",
    title: null,
    company: null,
    role: null,
    via: null,
    notes: null,
  });
  assert.equal(p1.company, "Example");
  assert.equal(p1.role, "Unknown Role");
  assert.equal(p1.via, "Direct");
  assert.equal(p1.notes, "Applied via Quick Apply");

  // All whitespace
  const p2 = parseQuickApply({
    url: "https://example.com/jobs/2",
    title: "   ",
    company: "   ",
    role: "   ",
    via: "   ",
    notes: "   ",
  });
  assert.equal(p2.company, "Example");
  assert.equal(p2.role, "Unknown Role");
  assert.equal(p2.via, "Direct");
  assert.equal(p2.notes, "Applied via Quick Apply");

  // Sanitizing tabs and newlines
  const p3 = parseQuickApply({
    url: "https://example.com/jobs/3",
    company: "Acme\tCorp\nLLC",
    role: "Staff\nArchitect\tLead",
    via: "Referral\tDirect",
    notes: "Applied\tvia\nPortal",
  });
  assert.equal(p3.company, "Acme Corp LLC");
  assert.equal(p3.role, "Staff Architect Lead");
  assert.equal(p3.via, "Referral Direct");
  assert.equal(p3.notes, "Applied via Portal");
});

test("parseTitle and parseQuickApply support Non-Latin and Unicode characters", () => {
  // Japanese title with @ separator
  const t1 = parseTitle("ソフトウェアエンジニア @ トヨタ自動車");
  assert.equal(t1.role, "ソフトウェアエンジニア");
  assert.equal(t1.company, "トヨタ自動車");

  // French title with hyphen
  const t2 = parseTitle("Développeur Fullstack - Société Générale");
  assert.equal(t2.role, "Développeur Fullstack");
  assert.equal(t2.company, "Société Générale");

  // German company with umlaut in quick apply
  const p1 = parseQuickApply({
    url: "https://example.com/jobs/42",
    company: "Münchener Rück",
    role: "Cloud-Ingenieur",
  });
  assert.equal(p1.company, "Münchener Rück");
  assert.equal(p1.role, "Cloud-Ingenieur");

  // Japanese explicit company and role
  const p2 = parseQuickApply({
    url: "https://example.com/jobs/99",
    company: "任天堂株式会社",
    role: "ゲームプログラマー",
    notes: "面接予定あり",
  });
  assert.equal(p2.company, "任天堂株式会社");
  assert.equal(p2.role, "ゲームプログラマー");
  assert.equal(p2.notes, "面接予定あり");
});

test("buildTrackerTsv builds canonical headed tracker addition TSV", () => {
  const item = {
    url: "https://example.com/jobs/1",
    company: "Acme",
    role: "Engineer",
    via: "Direct",
    notes: "Applied via Quick Apply",
  };
  const { tsvHeader, tsvRow, fullTsv } = buildTrackerTsv(item, "2026-10-19");
  assert.equal(
    tsvHeader,
    "#\tDate\tCompany\tRole\tVia\tStatus\tScore\tReport\tPDF\tNotes\tURL",
  );
  assert.equal(
    tsvRow,
    "—\t2026-10-19\tAcme\tEngineer\tDirect\tApplied\t—\t—\t❌\tApplied via Quick Apply\thttps://example.com/jobs/1",
  );
  assert.equal(fullTsv, `${tsvHeader}\n${tsvRow}\n`);
});

// --- 2. API Route POST Authentication & Validation Tests --------------------

const TEST_SECRET = "quick-apply-test-secret-42";

test("POST /api/tracker/quick-apply rejects missing or wrong auth with 401", async () => {
  const oldSecret = process.env.CAREER_OPS_WEBHOOK_SECRET;
  try {
    process.env.CAREER_OPS_WEBHOOK_SECRET = TEST_SECRET;

    const invalidAuthHeaders = [
      null, // missing
      "", // empty
      "Bearer", // missing token
      "Bearer ", // whitespace token
      "Bearer   ", // multiple spaces token
      "Bearer wrong-token", // wrong token
      "Basic dXNlcjpwYXNz", // wrong scheme
      `Bearer ${TEST_SECRET.toUpperCase()}`, // wrong token casing
    ];

    for (const auth of invalidAuthHeaders) {
      const headers = { "content-type": "application/json" };
      if (auth !== null) headers.authorization = auth;
      const req = new Request("http://localhost:3000/api/tracker/quick-apply", {
        method: "POST",
        headers,
        body: JSON.stringify({ url: "https://example.com" }),
      });
      const res = await POST(req);
      assert.equal(
        res.status,
        401,
        `Expected auth header "${auth}" to be rejected with 401`,
      );
      const json = await res.json();
      assert.equal(json.error, "Unauthorized");
    }

    // Secret environment handling: unset, empty string, whitespace
    const invalidEnvSecrets = [undefined, "", "   "];
    for (const envVal of invalidEnvSecrets) {
      if (envVal === undefined) {
        delete process.env.CAREER_OPS_WEBHOOK_SECRET;
      } else {
        process.env.CAREER_OPS_WEBHOOK_SECRET = envVal;
      }
      const req = new Request("http://localhost:3000/api/tracker/quick-apply", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_SECRET}`,
        },
        body: JSON.stringify({ url: "https://example.com" }),
      });
      const res = await POST(req);
      assert.equal(
        res.status,
        401,
        `Expected secret env value "${envVal}" to reject with 401`,
      );
    }
  } finally {
    process.env.CAREER_OPS_WEBHOOK_SECRET = oldSecret;
  }
});

test("POST /api/tracker/quick-apply accepts Bearer scheme in different cases", async () => {
  const oldSecret = process.env.CAREER_OPS_WEBHOOK_SECRET;
  try {
    process.env.CAREER_OPS_WEBHOOK_SECRET = TEST_SECRET;

    // Both "bearer" and "BEARER" scheme casing should authenticate past the auth barrier
    for (const scheme of ["Bearer", "bearer", "BEARER"]) {
      const req = new Request("http://localhost:3000/api/tracker/quick-apply", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `${scheme} ${TEST_SECRET}`,
        },
        // Passing invalid body here to trigger 400 rather than 401, proving auth succeeded
        body: JSON.stringify({ url: "" }),
      });
      const res = await POST(req);
      assert.notEqual(
        res.status,
        401,
        `Scheme "${scheme}" should not be rejected with 401`,
      );
      assert.equal(res.status, 400);
    }
  } finally {
    process.env.CAREER_OPS_WEBHOOK_SECRET = oldSecret;
  }
});

test("POST /api/tracker/quick-apply rejects missing or invalid URL with 400", async () => {
  const oldSecret = process.env.CAREER_OPS_WEBHOOK_SECRET;
  try {
    process.env.CAREER_OPS_WEBHOOK_SECRET = TEST_SECRET;

    const invalidBodies = [
      { title: "Some Title" }, // missing url
      { url: "" }, // empty url
      { url: "   " }, // whitespace url
      { url: "not a valid url" }, // malformed
      { url: "ftp://example.com" }, // ftp
      { url: "javascript:alert(1)" }, // javascript
      { url: "javascript://alert(1)" }, // javascript with slashes
      { url: 12345 }, // non-string url
    ];

    for (const b of invalidBodies) {
      const req = new Request("http://localhost:3000/api/tracker/quick-apply", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_SECRET}`,
        },
        body: JSON.stringify(b),
      });
      const res = await POST(req);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error, "Missing or invalid url");
    }

    // Invalid JSON payload
    const invalidJsonReq = new Request("http://localhost:3000/api/tracker/quick-apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_SECRET}`,
      },
      body: "this is not json {",
    });
    const invalidJsonRes = await POST(invalidJsonReq);
    assert.equal(invalidJsonRes.status, 400);
    const invalidJson = await invalidJsonRes.json();
    assert.equal(invalidJson.error, "Missing or invalid url");
  } finally {
    process.env.CAREER_OPS_WEBHOOK_SECRET = oldSecret;
  }
});

test("proxy and origin-guard allow no-origin requests and reject cross-origin requests", () => {
  // curl, Apple Shortcuts, and non-browser callers do not send Origin or Sec-Fetch-Site
  const directNoOrigin = checkRequest({
    secFetchSite: null,
    origin: null,
    host: "localhost:3000",
    allowedHosts: new Set(["localhost:3000"]),
    allowedOrigins: new Set(),
  });
  assert.equal(directNoOrigin.ok, true, "Direct no-origin request should be allowed");

  // Same-origin browser request
  const sameOrigin = checkRequest({
    secFetchSite: "same-origin",
    origin: "http://localhost:3000",
    host: "localhost:3000",
    allowedHosts: new Set(["localhost:3000"]),
    allowedOrigins: new Set(),
  });
  assert.equal(sameOrigin.ok, true, "Same-origin request should be allowed");

  // Cross-site request from untrusted origin (e.g. CSRF attack)
  const crossSite = checkRequest({
    secFetchSite: "cross-site",
    origin: "https://malicious-website.com",
    host: "localhost:3000",
    allowedHosts: new Set(["localhost:3000"]),
    allowedOrigins: new Set(),
  });
  assert.equal(crossSite.ok, false, "Cross-site request should be blocked");
  assert.equal(crossSite.status, 403);
});

// --- 3. End-to-End Staging, Merge, Status-Log & Follow-up Tests ---------------

function createTestSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "cops-quick-apply-test-"));
  const dataDir = join(dir, "data");
  const addsDir = join(dir, "batch", "tracker-additions");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(addsDir, { recursive: true });

  const trackerPath = join(dataDir, "applications.md");
  writeFileSync(
    trackerPath,
    [
      "# Applications Tracker",
      "",
      "| # | Date | Company | Role | Via | Status | Score | Report | PDF | Notes | URL |",
      "|---|------|---------|------|-----|--------|-------|--------|-----|-------|-----|",
      "",
    ].join("\n"),
    "utf8",
  );

  return { dir, trackerPath, addsDir, dataDir };
}

test("POST /api/tracker/quick-apply stages TSV, merges tracker, appends status-log, and seeds follow-ups", async () => {
  const sandbox = createTestSandbox();
  const oldEnv = { ...process.env };

  try {
    process.env.CAREER_OPS_WEBHOOK_SECRET = TEST_SECRET;
    process.env.CAREER_OPS_TRACKER = sandbox.trackerPath;
    process.env.CAREER_OPS_ADDITIONS = sandbox.addsDir;
    process.env.CAREER_OPS_FOLLOWUPS = join(sandbox.dataDir, "follow-ups.md");

    // Submit first application
    const req1 = new Request("http://localhost:3000/api/tracker/quick-apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_SECRET}`,
      },
      body: JSON.stringify({
        url: "https://boards.greenhouse.io/acme/jobs/123",
        title: "Senior Backend Engineer - Acme | Greenhouse",
      }),
    });

    const res1 = await POST(req1);
    assert.equal(res1.status, 200);
    const json1 = await res1.json();
    assert.equal(json1.ok, true);
    assert.equal(json1.company, "Acme");
    assert.equal(json1.role, "Senior Backend Engineer");
    assert.equal(json1.status, "Applied");

    // Verify tracker content
    const trackerContent1 = readFileSync(sandbox.trackerPath, "utf8");
    const rows1 = trackerContent1.split("\n").filter((l) => /^\|\s*\d/.test(l));
    assert.equal(rows1.length, 1, "Expected 1 tracker row");
    assert.match(rows1[0], /^\|\s*1\s*\|/);
    assert.match(rows1[0], /Acme/);
    assert.match(rows1[0], /Senior Backend Engineer/);
    assert.match(rows1[0], /Direct/);
    assert.match(rows1[0], /Applied/);
    assert.match(rows1[0], /https:\/\/boards\.greenhouse\.io\/acme\/jobs\/123/);

    // Verify TSV was moved to merged/
    const mergedDir = join(sandbox.addsDir, "merged");
    assert.equal(existsSync(mergedDir), true, "merged/ dir should exist");
    const mergedFiles1 = existsSync(mergedDir) ? (await import("node:fs")).readdirSync(mergedDir) : [];
    assert.equal(mergedFiles1.length, 1, "TSV should be archived to merged/");

    // Verify status-log.tsv
    const statusLogPath = join(sandbox.dataDir, "status-log.tsv");
    assert.equal(existsSync(statusLogPath), true, "status-log.tsv should exist");
    const statusLogContent1 = readFileSync(statusLogPath, "utf8");
    assert.match(statusLogContent1, /^1\t\d{4}-\d{2}-\d{2}\t-\tApplied\tweb\tApplied via Quick Apply/m);

    // Verify follow-ups.md seeded
    const followupsPath = join(sandbox.dataDir, "follow-ups.md");
    assert.equal(existsSync(followupsPath), true, "follow-ups.md should exist");
    const followupsContent1 = readFileSync(followupsPath, "utf8");
    assert.match(followupsContent1, /next #1/);

    // Submit second application (distinct company & role)
    const req2 = new Request("http://localhost:3000/api/tracker/quick-apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_SECRET}`,
      },
      body: JSON.stringify({
        url: "https://jobs.lever.co/stripe/staff-eng-456",
        title: "Staff Engineer at Stripe",
        via: "Recruiter Reachout",
        notes: "Emailed by recruiter John",
      }),
    });

    const res2 = await POST(req2);
    assert.equal(res2.status, 200);
    const json2 = await res2.json();
    assert.equal(json2.ok, true);
    assert.equal(json2.company, "Stripe");
    assert.equal(json2.role, "Staff Engineer");
    assert.equal(json2.status, "Applied");

    // Verify row #2 in tracker
    const trackerContent2 = readFileSync(sandbox.trackerPath, "utf8");
    const rows2 = trackerContent2.split("\n").filter((l) => /^\|\s*\d/.test(l));
    assert.equal(rows2.length, 2, "Expected 2 tracker rows");
    assert.match(rows2[1], /^\|\s*2\s*\|/);
    assert.match(rows2[1], /Stripe/);
    assert.match(rows2[1], /Staff Engineer/);
    assert.match(rows2[1], /Recruiter Reachout/);
    assert.match(rows2[1], /Emailed by recruiter John/);

    // Verify status-log line for #2
    const statusLogContent2 = readFileSync(statusLogPath, "utf8");
    assert.match(statusLogContent2, /^2\t\d{4}-\d{2}-\d{2}\t-\tApplied\tweb\tEmailed by recruiter John/m);

    // Verify follow-ups for #2
    const followupsContent2 = readFileSync(followupsPath, "utf8");
    assert.match(followupsContent2, /next #2/);

    // Submit third application with Non-Latin Unicode characters
    const req3 = new Request("http://localhost:3000/api/tracker/quick-apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_SECRET}`,
      },
      body: JSON.stringify({
        url: "https://example.jp/jobs/789",
        company: "任天堂株式会社",
        role: "ゲームプログラマー",
        notes: "日本語のメモ",
      }),
    });

    const res3 = await POST(req3);
    assert.equal(res3.status, 200);
    const json3 = await res3.json();
    assert.equal(json3.ok, true);
    assert.equal(json3.company, "任天堂株式会社");
    assert.equal(json3.role, "ゲームプログラマー");
    assert.equal(json3.status, "Applied");

    // Verify row #3 in tracker has exact Unicode strings
    const trackerContent3 = readFileSync(sandbox.trackerPath, "utf8");
    const rows3 = trackerContent3.split("\n").filter((l) => /^\|\s*\d/.test(l));
    assert.equal(rows3.length, 3, "Expected 3 tracker rows");
    assert.match(rows3[2], /^\|\s*3\s*\|/);
    assert.match(rows3[2], /任天堂株式会社/);
    assert.match(rows3[2], /ゲームプログラマー/);
    assert.match(rows3[2], /日本語のメモ/);

    // Verify status-log line for #3
    const statusLogContent3 = readFileSync(statusLogPath, "utf8");
    assert.match(statusLogContent3, /^3\t\d{4}-\d{2}-\d{2}\t-\tApplied\tweb\t日本語のメモ/m);

    // Verify follow-ups for #3
    const followupsContent3 = readFileSync(followupsPath, "utf8");
    assert.match(followupsContent3, /next #3/);

    // Verify merged directory has 3 files, and no unmerged TSVs in addsDir
    const fs = await import("node:fs");
    const pendingAdditions = fs.readdirSync(sandbox.addsDir).filter((f) => f.endsWith(".tsv"));
    assert.equal(pendingAdditions.length, 0, "No pending additions should remain in addsDir");
    const mergedFiles = fs.readdirSync(mergedDir);
    assert.equal(mergedFiles.length, 3, "All 3 TSVs should be moved to merged/");
  } finally {
    process.env = oldEnv;
    try {
      rmSync(sandbox.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});
