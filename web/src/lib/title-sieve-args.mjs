import { scopeFrom } from "./claude-invocation.mjs";

// The sieve judges titles from what the model knows, with web search allowed for
// the occasional unrecognisable company or role. Claude can be granted exactly
// that; the deny list for everything else is derived, never hand-written.
const SIEVE_SCOPE = scopeFrom("WebSearch");

/**
 * argv for one title-sieve call. Claude gets the small model (title
 * classification is the cheapest job in the system) and WebSearch only; every
 * other CLI uses its registered plain-text invocation — for Antigravity that is
 * the user's own `--dangerously-skip-permissions` setup, since agy has no
 * per-tool allow list.
 *
 * @param {string} cliId
 * @param {string} prompt
 * @param {(prompt: string) => string[]} plainArgs - the CliSpec's `args`
 * @param {Record<string, string | undefined>} [env] - reads CAREER_OPS_SIEVE_MODEL
 * @returns {string[]}
 */
export function titleSieveArgs(cliId, prompt, plainArgs, env = process.env) {
  const model = (fallback) => env.CAREER_OPS_SIEVE_MODEL?.trim() || fallback;
  // agy's default model took ~200s for a one-line answer; flash answers in ~5s.
  if (cliId === "antigravity") return [...plainArgs(prompt), "--model", model("gemini-3.8-flash-medium")];
  if (cliId !== "claude") return plainArgs(prompt);
  return [
    "-p",
    prompt,
    "--model",
    model("haiku"),
    "--output-format",
    "text",
    // Required for a non-writing worker — see cli-fencing.mjs (#2507).
    "--strict-mcp-config",
    "--allowedTools",
    SIEVE_SCOPE.allowed,
    "--disallowedTools",
    SIEVE_SCOPE.disallowed,
  ];
}
