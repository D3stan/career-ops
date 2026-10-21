import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("push-pipeline --dry-run needs no remote/token and makes no request", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pp-")), "p.md");
  fs.writeFileSync(f, "- [ ] https://x.com/j/1 | Acme | Engineer\n");
  const r = spawnSync(process.execPath, ["../scripts/push-pipeline.mjs", "--file", f, "--dry-run"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Dry run: 1 offer/);
  assert.match(r.stdout, /Acme/);
});
