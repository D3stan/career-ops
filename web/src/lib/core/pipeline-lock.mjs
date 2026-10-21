import path from "node:path";
import fs from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolveDataRoot } from "./data-root.mjs";

const modCache = new Map();

export function getDataRoot() {
  const coreRoot = path.resolve(process.cwd(), "..");
  return resolveDataRoot(
    coreRoot,
    (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    process.env,
    path.resolve,
    path.join,
  );
}

function findPipelineLockPath() {
  const candidates = [
    path.join(getDataRoot(), "pipeline-lock.mjs"),
    path.resolve(process.cwd(), "pipeline-lock.mjs"),
    path.resolve(process.cwd(), "..", "pipeline-lock.mjs"),
  ];
  try {
    const fromMeta = path.resolve(fileURLToPath(import.meta.url), "../../../../../pipeline-lock.mjs");
    candidates.push(fromMeta);
  } catch {
    // ignore
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function loadCoreLock() {
  const file = findPipelineLockPath();
  if (!file) return null;
  const cached = modCache.get(file);
  if (cached) return cached;
  const mod = await import(/* webpackIgnore: true */ pathToFileURL(file).href);
  if (typeof mod.withPipelineLock !== "function") {
    throw new Error("pipeline-lock.mjs has no withPipelineLock export");
  }
  const api = mod.withPipelineLock;
  modCache.set(file, api);
  return api;
}

export class PipelineBusyError extends Error {
  constructor(message = "pipeline is being written by another process") {
    super(message);
    this.name = "PipelineBusyError";
  }
}

/**
 * Run `fn` holding the core's pipeline lock, and release it on EVERY path.
 *
 * @param {string} pipelinePath absolute path to data/pipeline.md
 * @param {Function} fn the read-modify-write operation
 * @param {object} [options] optional timeout/retry overrides
 */
export async function withPipelineLock(pipelinePath, fn, options = {}) {
  const core = await loadCoreLock();
  if (!core) {
    return await fn();
  }
  try {
    return await core(pipelinePath, fn, {
      timeoutMs: Number(process.env.CAREER_OPS_WEB_PIPELINE_LOCK_TIMEOUT_MS) || 5_000,
      ...options,
    });
  } catch (e) {
    if (e?.name === "LockTimeoutError" || e?.code === "LOCK_TIMEOUT") {
      throw new PipelineBusyError(e.message);
    }
    throw e;
  }
}
