import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

export function backup(file) {
  try {
    const cur = fs.readFileSync(file, "utf8");
    if (!cur.trim()) return null;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const bak = `${file}.bak-${ts}`;
    fs.writeFileSync(bak, cur, "utf8");
    return bak;
  } catch {
    return null;
  }
}

export function atomicWriteWithBackup(file, content) {
  const bak = backup(file);
  atomicWrite(file, content);
  return bak;
}
