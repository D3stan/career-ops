import { resolveCli } from "./clis";
import { spawnHeadlessCli } from "./spawn-cli.mjs";
import { CAPS } from "./worker-capabilities.mjs";

// `agy -p "/usage" --output-format json` answers from Antigravity's own account
// state — it reports `num_turns: 0` / `usage.total_tokens: 0`, so calling it
// costs no model quota. It's slow to spawn (observed 7-10s: process start +
// an auth/network round trip), so callers should cache aggressively rather
// than call this per page load.
const TIMEOUT_MS = 20_000;

/**
 * @returns {Promise<
 *   | { ok: true, window5h: { usedPct: number, resetTime: string }, weekly: { usedPct: number, resetTime: string } }
 *   | { ok: false, error: string }
 * >}
 */
export async function fetchAntigravityUsage() {
  const resolved = resolveCli("antigravity");
  if (!resolved) return { ok: false, error: "antigravity CLI not found on PATH" };
  const { binPath } = resolved;

  let child;
  try {
    child = spawnHeadlessCli(
      binPath,
      ["-p", "/usage", "--output-format", "json"],
      { env: process.env },
      { cliId: "antigravity", capabilities: CAPS.localReadOnly },
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return await new Promise((resolvePromise) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: "agy /usage timed out" });
    }, TIMEOUT_MS);

    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", (err) => finish({ ok: false, error: err.message }));
    child.on("close", () => {
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        finish({ ok: false, error: "could not parse agy /usage output" });
        return;
      }
      const groups = parsed?.command?.data?.groups;
      const gemini = Array.isArray(groups) ? groups.find((g) => g?.name === "Gemini Models") : null;
      const buckets = Array.isArray(gemini?.buckets) ? gemini.buckets : [];
      const fiveH = buckets.find((b) => b?.window === "5h");
      const weekly = buckets.find((b) => b?.window === "weekly");
      if (!fiveH || typeof fiveH.remaining_fraction !== "number" || !weekly || typeof weekly.remaining_fraction !== "number") {
        finish({ ok: false, error: "unexpected agy /usage shape (Gemini Models group missing)" });
        return;
      }
      finish({
        ok: true,
        window5h: { usedPct: Math.round((1 - fiveH.remaining_fraction) * 100), resetTime: fiveH.reset_time },
        weekly: { usedPct: Math.round((1 - weekly.remaining_fraction) * 100), resetTime: weekly.reset_time },
      });
    });
  });
}
