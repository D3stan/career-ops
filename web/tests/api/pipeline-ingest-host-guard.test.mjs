import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRequest, parseAllowedHosts } from "../../src/lib/origin-guard.mjs";

const base = { secFetchSite: null, origin: null, allowedOrigins: undefined };

test("public VPS host is blocked unless allowlisted", () => {
  const r = checkRequest({ ...base, host: "jobs.example.com", allowedHosts: parseAllowedHosts("") });
  assert.equal(r.ok, false);
});

test("allowlisted public host passes for a non-browser push client", () => {
  const r = checkRequest({ ...base, host: "jobs.example.com", allowedHosts: parseAllowedHosts("jobs.example.com") });
  assert.equal(r.ok, true);
});
