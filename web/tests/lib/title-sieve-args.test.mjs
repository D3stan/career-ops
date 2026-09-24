import { test } from "node:test";
import assert from "node:assert/strict";
import { titleSieveArgs } from "../../src/lib/title-sieve-args.mjs";
import { verifyClaudeArgs } from "../../src/lib/claude-invocation.mjs";
import { CAPS } from "../../src/lib/worker-capabilities.mjs";

test("claude sieve argv passes the web-search-only fence", () => {
  const args = titleSieveArgs("claude", "PROMPT", () => []);
  assert.doesNotThrow(() => verifyClaudeArgs(args, CAPS.webSearchOnly));
  assert.equal(args[args.indexOf("-p") + 1], "PROMPT");
});

test("other CLIs use their registered plain-text argv", () => {
  assert.deepEqual(titleSieveArgs("gemini", "P", (p) => ["-p", p]), ["-p", "P"]);
});

test("claude sieve may search but never fetch or write", () => {
  const args = titleSieveArgs("claude", "P", () => []);
  const denied = args[args.indexOf("--disallowedTools") + 1].split(",");
  for (const t of ["WebFetch", "Write", "Edit", "Bash"]) assert.ok(denied.includes(t), t);
  assert.equal(args[args.indexOf("--allowedTools") + 1], "WebSearch");
});

test("antigravity keeps the user's argv and gets a fast model, overridable", () => {
  const plain = (p) => ["--dangerously-skip-permissions", "-p", p];
  const a = titleSieveArgs("antigravity", "P", plain, {});
  assert.deepEqual(a.slice(0, 3), ["--dangerously-skip-permissions", "-p", "P"]);
  assert.equal(a[a.indexOf("--model") + 1], "gemini-3.8-flash-medium");
  const b = titleSieveArgs("antigravity", "P", plain, { CAREER_OPS_SIEVE_MODEL: "claude-sonnet-4-6" });
  assert.equal(b[b.indexOf("--model") + 1], "claude-sonnet-4-6");
});
