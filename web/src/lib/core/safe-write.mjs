import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Plain-JS twin of safe-write.ts, importable from node --test and .mjs modules
// (e.g. the pipeline ingest route). KEEP IN STEP with safe-write.ts: that file
// is the one the upstream tests (safe-write-temp-cleanup) inspect textually, so
// it stays a full implementation rather than a re-export of this one.

export function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    // The temp file holds a full copy of the user-layer file; never leave it behind.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The write already failed; the leftover is unstageable (.gitignore `*.tmp*`).
    }
    throw err;
  }
}

export function backup(file) {
  let cur;
  try {
    cur = fs.readFileSync(file);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (!cur.toString("utf8").trim()) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${file}.bak-${ts}`;
  // Once there is prior content, a failed backup must stop the replacement.
  fs.writeFileSync(bak, cur);
  return bak;
}

export function atomicWriteWithBackup(file, content) {
  const bak = backup(file);
  atomicWrite(file, content);
  return bak;
}
