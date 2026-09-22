# Reload-Safe Background Evaluation Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser tab reload/close must stop the live progress *feed* only — it must never kill the agent CLI process that is actually running an evaluation (or a pdf tailoring run), so the job finishes on the server exactly as if the tab were still open.

**Architecture:** `web/src/app/api/run/route.ts` currently uses one boolean (`closed`) to mean both "stop writing to the browser" and "the job is over," so its `ReadableStream`'s `cancel()` (fired on client disconnect) kills the spawned child process. Split that into two independent, explicit concerns via a small new state-machine module, wire it through `route.ts` so `cancel()` only detaches the stream, then fix the client (`job-store.tsx` and three UI surfaces) so a job that outlived its tab is shown honestly (a new `"unknown"` status) instead of falsely labeled `"error"` / "Interrupted."

**Tech Stack:** Next.js App Router (Node runtime), TypeScript, plain `.mjs` for testable logic, React client components, `node:test` for unit tests.

**Working directory note:** Another agent session is concurrently modifying `web/src/app/api/usage/route.ts`, `web/src/components/usage-meter.tsx`, and `web/src/lib/antigravity-usage.mjs` (agent-quota UI work), plus there's a pre-existing unrelated modification to `portals.yml`. **None of the files in this plan overlap with those.** Every task below stages and commits only the exact files it lists — never `git add -A` / `git add .` — and every git command in this plan is preceded by `git status --short` to confirm no unrelated file has crept in. Do not read, edit, or otherwise interact with the other agent's files or its session.

---

## File Structure

| File | Change |
|---|---|
| `web/src/lib/core/run-stream-lifecycle.mjs` | **Create.** Pure state machine: stream-closed vs. job-settled. |
| `web/tests/lib/run-stream-lifecycle.test.mjs` | **Create.** Unit tests for the above. |
| `web/src/app/api/run/route.ts` | **Modify.** Replace the `closed` boolean with the lifecycle module; `cancel()` no longer kills the child. |
| `web/src/components/jobs/job-store.tsx` | **Modify.** `Job["status"]` gains `"unknown"`; the reload-restore effect stops asserting failure. |
| `web/src/components/jobs/worker-card.tsx` | **Modify.** Add a neutral icon branch for `"unknown"`. |
| `web/src/app/jobs/page.tsx` | **Modify.** Same icon-branch fix, history list. |
| `web/src/app/jobs/[id]/page.tsx` | **Modify.** Same icon-branch fix, detail header pill. |
| `web/src/lib/job-error-hint.mjs` | **Modify.** Delete the now-dead `"Interrupted (page reloaded)"` mapping. |
| `web/tests/lib/job-error-hint.test.mjs` | **Modify.** Remove the two tests for the retired label. |

No other files change. Spec: `docs/superpowers/specs/2026-09-22-reload-safe-background-jobs-design.md`.

---

### Task 1: `run-stream-lifecycle.mjs` — the stream/job state split

**Files:**
- Create: `web/src/lib/core/run-stream-lifecycle.mjs`
- Test: `web/tests/lib/run-stream-lifecycle.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `web/tests/lib/run-stream-lifecycle.test.mjs`:

```js
// Tests for the run-stream lifecycle state machine using Node's built-in test runner.
// Run:  node --test tests/lib/run-stream-lifecycle.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunLifecycle } from "../../src/lib/core/run-stream-lifecycle.mjs";

test("starts with neither stream closed nor settled", () => {
  const lifecycle = createRunLifecycle();
  assert.equal(lifecycle.isStreamClosed(), false);
  assert.equal(lifecycle.isSettled(), false);
});

test("onDisconnect marks the stream closed but does NOT settle", () => {
  const lifecycle = createRunLifecycle();
  lifecycle.onDisconnect();
  assert.equal(lifecycle.isStreamClosed(), true);
  assert.equal(lifecycle.isSettled(), false);
});

test("onStreamWriteFailed marks the stream closed but does NOT settle", () => {
  const lifecycle = createRunLifecycle();
  lifecycle.onStreamWriteFailed();
  assert.equal(lifecycle.isStreamClosed(), true);
  assert.equal(lifecycle.isSettled(), false);
});

test("settleOnce runs its callback and marks both flags true", () => {
  const lifecycle = createRunLifecycle();
  let ran = 0;
  const didRun = lifecycle.settleOnce(() => { ran++; });
  assert.equal(didRun, true);
  assert.equal(ran, 1);
  assert.equal(lifecycle.isSettled(), true);
  assert.equal(lifecycle.isStreamClosed(), true);
});

test("settleOnce after a disconnect still runs its callback (the job outlives the browser)", () => {
  const lifecycle = createRunLifecycle();
  lifecycle.onDisconnect();
  let ran = 0;
  const didRun = lifecycle.settleOnce(() => { ran++; });
  assert.equal(didRun, true);
  assert.equal(ran, 1);
  assert.equal(lifecycle.isSettled(), true);
});

test("settleOnce called twice only runs its callback once", () => {
  const lifecycle = createRunLifecycle();
  let ran = 0;
  lifecycle.settleOnce(() => { ran++; });
  const secondRun = lifecycle.settleOnce(() => { ran++; });
  assert.equal(secondRun, false);
  assert.equal(ran, 1);
});

test("onDisconnect after settleOnce is a harmless no-op", () => {
  const lifecycle = createRunLifecycle();
  lifecycle.settleOnce(() => {});
  lifecycle.onDisconnect();
  assert.equal(lifecycle.isSettled(), true);
  assert.equal(lifecycle.isStreamClosed(), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && node --test tests/lib/run-stream-lifecycle.test.mjs`
Expected: FAIL — `Cannot find module '.../src/lib/core/run-stream-lifecycle.mjs'`

- [ ] **Step 3: Write the implementation**

Create `web/src/lib/core/run-stream-lifecycle.mjs`:

```js
// Tracks the two independent lifecycles of a single /api/run stream:
//  - the HTTP stream to the browser, which can go away at any time
//    (tab reload/close, network drop) without the job itself ending
//  - the underlying job (the spawned agent CLI process + its tracker
//    write-token guard), which keeps running after a disconnect and
//    settles exactly once, only when it actually finishes
//
// Before this existed, route.ts used ONE `closed` boolean for both concerns,
// so a browser disconnect could only be handled by tearing down everything —
// including killing the still-running agent mid-evaluation. Splitting the two
// lets a disconnect stop the stream without stopping the job.
export function createRunLifecycle() {
  let streamClosed = false;
  let settled = false;
  return {
    isStreamClosed: () => streamClosed,
    isSettled: () => settled,
    /** The browser disconnected (tab reload/close). The job is unaffected. */
    onDisconnect() {
      streamClosed = true;
    },
    /** A write to the browser stream failed on its own (already-dead controller). */
    onStreamWriteFailed() {
      streamClosed = true;
    },
    /** Runs `fn` (the one-time job-finished cleanup) exactly once. Returns whether it ran. */
    settleOnce(fn) {
      if (settled) return false;
      settled = true;
      streamClosed = true;
      fn();
      return true;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && node --test tests/lib/run-stream-lifecycle.test.mjs`
Expected: PASS — 7 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git status --short
git add web/src/lib/core/run-stream-lifecycle.mjs web/tests/lib/run-stream-lifecycle.test.mjs
git status --short
git commit -m "$(cat <<'EOF'
feat(web): add run-stream lifecycle state machine

Splits the single closed boolean route.ts used for a run's stream into
two independent concerns (stream-closed vs job-settled), so a browser
disconnect can stop the former without triggering the latter. Wiring
into route.ts's cancel() follows in the next commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

Confirm the second `git status --short` shows only the two new files staged before committing — if anything else appears, stop and ask before proceeding.

---

### Task 2: Wire the lifecycle into `route.ts` — stop killing the child on disconnect

**Files:**
- Modify: `web/src/app/api/run/route.ts:19,195,266,274,300-308,366-367,436-444,543-556`

- [ ] **Step 1: Add the import**

In `web/src/app/api/run/route.ts`, directly below the existing `run-registry` import:

```ts
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";
import { createRunLifecycle } from "@/lib/core/run-stream-lifecycle.mjs";
```

- [ ] **Step 2: Replace the `closed` boolean with the lifecycle**

Find:

```ts
      let closed = false;
      let killer: ReturnType<typeof setTimeout> | undefined;
```

Replace with:

```ts
      const lifecycle = createRunLifecycle();
      let killer: ReturnType<typeof setTimeout> | undefined;
```

- [ ] **Step 3: Update `send()`**

Find:

```ts
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
        } catch {
          // The client is gone. Stop the heartbeat here rather than waiting for
          // close(): the child can still run for minutes (maxDuration 800s), and
          // a user retrying a failed run would otherwise accumulate one live
          // timer per abandoned request.
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
        }
      };
```

Replace with:

```ts
      const send = (obj: unknown) => {
        if (lifecycle.isStreamClosed()) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
        } catch {
          // The client is gone. Stop the heartbeat here rather than waiting for
          // close(): the child can still run for minutes (maxDuration 800s), and
          // a user retrying a failed run would otherwise accumulate one live
          // timer per abandoned request.
          lifecycle.onStreamWriteFailed();
          if (heartbeat) clearInterval(heartbeat);
        }
      };
```

- [ ] **Step 4: Update `close()` to settle exactly once, independent of the stream**

Find:

```ts
      const close = () => {
        if (!closed) {
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          if (killer) clearTimeout(killer);
          releaseWriteTokenOnce();
          try { controller.close(); } catch { /* */ }
        }
      };
```

Replace with:

```ts
      const close = () => {
        // settleOnce is the ONLY place the job's real resources (the kill
        // timer, the tracker write-token) get released — it runs from the
        // child's own close/error handlers (or renderPdf's finally), never
        // from a browser disconnect. See run-stream-lifecycle.mjs.
        lifecycle.settleOnce(() => {
          if (heartbeat) clearInterval(heartbeat);
          if (killer) clearTimeout(killer);
          releaseWriteTokenOnce();
          try { controller.close(); } catch { /* */ }
        });
      };
```

- [ ] **Step 5: Keep parsing stdout after a disconnect**

Find:

```ts
      child.stdout.on("data", (chunk: string) => {
        if (closed) return;
        if (!spec.parseEvent) {
```

Replace with:

```ts
      child.stdout.on("data", (chunk: string) => {
        // Deliberately NOT gated on lifecycle.isStreamClosed(): parsing must
        // continue after a disconnect so emittedText/sawError/token
        // accounting stay correct for the close-time honesty gate below, and
        // so pdf mode's cvFilter still sees the whole <<cv-html>> envelope
        // even if the browser left partway through. send()/sendAgentText()
        // already no-op once the stream is closed, so this costs nothing.
        if (!spec.parseEvent) {
```

- [ ] **Step 6: Update the `child.on("close", ...)` re-entry guard**

Find:

```ts
      child.on("close", (code) => {
        // A trailing line with no newline would otherwise never be tested.
        if (stderrBuf) { flagStderrLine(stderrBuf); stderrBuf = ""; }
        // A client disconnect can fire cancel() (which kills `child`) before
        // this event finally arrives — killing a process doesn't make its
        // 'close' event disappear, just delays it. Without this guard a pdf
        // run could still start a brand-new render (and re-touch the tracker)
        // after the stream — and its writeToken guard — is already gone.
        if (closed) return;
```

Replace with:

```ts
      child.on("close", (code) => {
        // A trailing line with no newline would otherwise never be tested.
        if (stderrBuf) { flagStderrLine(stderrBuf); stderrBuf = ""; }
        // child.on("error") may already have settled this run (see below). If
        // 'close' still arrives afterward, the pdf branch below has real side
        // effects (saveCv, kicking off a new render) — re-entering it after
        // settle must be refused, not just re-messaging an already-closed
        // stream. A browser disconnect alone does NOT settle, so this guard
        // no longer fires on a plain reload — the job runs this handler for
        // real when it actually finishes.
        if (lifecycle.isSettled()) return;
```

- [ ] **Step 7: Stop killing the child in `cancel()`**

Find:

```ts
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (killer) clearTimeout(killer);
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      if (pdfRenderPromise) {
        // Render/mark keeps running after this client disconnects — wait for
        // it to settle before releasing the guard, so a concurrent tracker
        // delete can't race mark-pdf-ready.mjs's still-in-flight write.
        pdfRenderPromise.finally(releaseWriteTokenOnce);
      } else {
        releaseWriteTokenOnce();
      }
    },
```

Replace with:

```ts
    cancel() {
      // A browser disconnect (tab reload/close, lost connection) stops the
      // STREAM, never the JOB: the agent CLI keeps running and writes its
      // report / merges the tracker exactly as if the tab were still open.
      // killer is deliberately left running — once nobody's watching, it's
      // the only thing left that can still stop a truly hung agent. The
      // write token is released only when the job actually finishes, via
      // close() (called from the child's own close/error handlers, or
      // renderPdf's finally) — never from here.
      lifecycle.onDisconnect();
      if (heartbeat) clearInterval(heartbeat);
    },
```

- [ ] **Step 8: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors. (This task has no dedicated unit test — Task 1 already covers the extracted state-machine logic in isolation, and `route.ts` spawns real processes/returns platform `Response` objects, which this repo's existing convention does not unit-test directly. Full behavioral verification is Task 6's manual check.)

- [ ] **Step 9: Commit**

```bash
git status --short
git add web/src/app/api/run/route.ts
git status --short
git commit -m "$(cat <<'EOF'
fix(web): stop killing the agent CLI on browser disconnect

/api/run's stream cancel() used to SIGTERM the spawned agent whenever
the client disconnected (tab reload/close), so a page reload mid-
evaluation silently killed the job with no report or tracker update.
cancel() now only detaches the stream; the child keeps running and
settles for real via its own close()/error() handlers (or the killMs
safety-net timeout, which cancel() no longer clears either).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

Confirm the second `git status --short` shows only `route.ts` staged before committing.

---

### Task 3: Client — honest status for a job that outlived its tab

**Files:**
- Modify: `web/src/components/jobs/job-store.tsx:18,65-77`

- [ ] **Step 1: Extend the `Job["status"]` type**

Find:

```ts
  status: "running" | "done" | "error";
```

Replace with:

```ts
  status: "running" | "done" | "error" | "unknown"; // "unknown": job outlived its tab (reload/close) — may have finished on the server
```

- [ ] **Step 2: Stop asserting failure on restore**

Find:

```ts
  // restore history
  useEffect(() => {
    try {
      const raw = localStorage.getItem(JOBS_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) {
        // anything left "running" from a previous session is stale → mark interrupted
        setJobs(arr.map((j: Job) => (j.status === "running" ? { ...j, status: "error", steps: [...(j.steps || []), { kind: "status", label: "Interrupted (page reloaded)", ts: Date.now() }] } : j)));
      }
    } catch {
      /* ignore */
    }
    loaded.current = true;
  }, []);
```

Replace with:

```ts
  // restore history
  useEffect(() => {
    try {
      const raw = localStorage.getItem(JOBS_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) {
        // A job still "running" from a previous session means this TAB's view
        // of it is gone — not that the job itself stopped: /api/run no longer
        // kills the agent CLI on a browser disconnect, so the evaluation kept
        // running on the server. Only the live progress feed was lost.
        setJobs(arr.map((j: Job) => (j.status === "running" ? { ...j, status: "unknown", steps: [...(j.steps || []), { kind: "status", label: "Reload closed this tab's view — the evaluation kept running on the server. Check Pipeline for the result.", ts: Date.now() }] } : j)));
      }
    } catch {
      /* ignore */
    }
    loaded.current = true;
  }, []);
```

- [ ] **Step 3: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: errors in the three consumer files (worker-card.tsx, jobs/page.tsx, jobs/[id]/page.tsx) if TypeScript flags the now-non-exhaustive ternaries, or no errors if it doesn't (plain `===` ternaries aren't exhaustively checked by default). Either way, proceed to Task 4 — those files need the `"unknown"` branch regardless, for correct rendering.

- [ ] **Step 4: Commit**

```bash
git status --short
git add web/src/components/jobs/job-store.tsx
git status --short
git commit -m "$(cat <<'EOF'
fix(web): don't claim a reload-orphaned job failed

Job.status gains "unknown": a job still "running" when a fresh page
load reads it back out of localStorage no longer gets relabeled
"error" / "Interrupted (page reloaded)" — since the previous commit,
that claim is usually false. It's now labeled honestly as having
outlived its tab, with a pointer to check Pipeline for the result.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: UI — render `"unknown"` as neutral, not as failure

**Files:**
- Modify: `web/src/components/jobs/worker-card.tsx:4,102-108`
- Modify: `web/src/app/jobs/page.tsx:4,49-55`
- Modify: `web/src/app/jobs/[id]/page.tsx:7,39-46`

- [ ] **Step 1: `worker-card.tsx` — import `HelpCircle`**

Find:

```tsx
import { Check, X, Loader2, AlertTriangle } from "lucide-react";
```

Replace with:

```tsx
import { Check, X, Loader2, AlertTriangle, HelpCircle } from "lucide-react";
```

- [ ] **Step 2: `worker-card.tsx` — add the icon branch**

Find:

```tsx
        {job.status === "running" ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-brand" />
        ) : job.status === "error" ? (
          <AlertTriangle className={cn("size-3 shrink-0", tone.icon)} />
        ) : (
          <Check className={cn("size-3 shrink-0", tone.icon)} />
        )}
```

Replace with:

```tsx
        {job.status === "running" ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-brand" />
        ) : job.status === "error" ? (
          <AlertTriangle className={cn("size-3 shrink-0", tone.icon)} />
        ) : job.status === "unknown" ? (
          <HelpCircle className={cn("size-3 shrink-0", tone.icon)} />
        ) : (
          <Check className={cn("size-3 shrink-0", tone.icon)} />
        )}
```

(`pillTone()` in this same file already defaults any status other than `"error"`/`"done"` to `"muted"`, so `tone.icon` is already correct for `"unknown"` — no change needed there.)

- [ ] **Step 3: `jobs/page.tsx` — import `HelpCircle`**

Find:

```tsx
import { Check, AlertTriangle, Loader2, Trash2 } from "lucide-react";
```

Replace with:

```tsx
import { Check, AlertTriangle, Loader2, Trash2, HelpCircle } from "lucide-react";
```

- [ ] **Step 4: `jobs/page.tsx` — add the icon branch**

Find:

```tsx
                  {j.status === "running" ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-brand" />
                  ) : j.status === "error" ? (
                    <AlertTriangle className="size-4 shrink-0 text-red-400" />
                  ) : (
                    <Check className="size-4 shrink-0 text-emerald-500" />
                  )}
```

Replace with:

```tsx
                  {j.status === "running" ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-brand" />
                  ) : j.status === "error" ? (
                    <AlertTriangle className="size-4 shrink-0 text-red-400" />
                  ) : j.status === "unknown" ? (
                    <HelpCircle className="size-4 shrink-0 text-zinc-400" />
                  ) : (
                    <Check className="size-4 shrink-0 text-emerald-500" />
                  )}
```

(The raw `{j.status}` label lower in this file already renders `"unknown"` correctly via `capitalize` — no change needed.)

- [ ] **Step 5: `jobs/[id]/page.tsx` — import `HelpCircle`**

Find:

```tsx
import { ArrowLeft, Loader2, Wrench, CircleDot, Check, X } from "lucide-react";
```

Replace with:

```tsx
import { ArrowLeft, Loader2, Wrench, CircleDot, Check, X, HelpCircle } from "lucide-react";
```

- [ ] **Step 6: `jobs/[id]/page.tsx` — add the header-pill branch**

Find:

```tsx
            {job.status === "running" ? (
              <><Loader2 className="size-3 animate-spin text-brand" /> working</>
            ) : job.status === "done" ? (
              <><Check className="size-3 text-emerald-500" /> done</>
            ) : (
              <><X className="size-3 text-red-400" /> error</>
            )}
```

Replace with:

```tsx
            {job.status === "running" ? (
              <><Loader2 className="size-3 animate-spin text-brand" /> working</>
            ) : job.status === "done" ? (
              <><Check className="size-3 text-emerald-500" /> done</>
            ) : job.status === "unknown" ? (
              <><HelpCircle className="size-3 text-zinc-400" /> unknown</>
            ) : (
              <><X className="size-3 text-red-400" /> error</>
            )}
```

- [ ] **Step 7: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git status --short
git add web/src/components/jobs/worker-card.tsx web/src/app/jobs/page.tsx "web/src/app/jobs/[id]/page.tsx"
git status --short
git commit -m "$(cat <<'EOF'
fix(web): render unknown-status jobs as neutral, not failed

worker-card.tsx, jobs/page.tsx and jobs/[id]/page.tsx each defaulted
any non-running/non-done status to a red error icon. Job.status can
now be "unknown" (a job that outlived its tab) — give it its own
neutral HelpCircle icon in all three surfaces instead of misreading
it as a failure.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Retire the dead "Interrupted (page reloaded)" hint

**Files:**
- Modify: `web/src/lib/job-error-hint.mjs`
- Modify: `web/tests/lib/job-error-hint.test.mjs`

- [ ] **Step 1: Remove the two tests for the retired label**

In `web/tests/lib/job-error-hint.test.mjs`, delete these two `test(...)` blocks in full:

```js
test("page-reload interruption -> interrupted hint, NOT auth", () => {
  const hint = jobErrorHint(errorJob("Interrupted (page reloaded)"));
  assert.equal(hint?.kind, "interrupted");
  assert.equal(hint?.text, "The run was interrupted — re-run it.");
});
```

and

```js
test("interrupted with unrelated auth-flavored assistant text -> still interrupted, NOT auth", () => {
  const text = "This product requires the user to authenticate via SSO login with their corporate credentials.";
  const hint = jobErrorHint(errorJob("Interrupted (page reloaded)", text));
  assert.equal(hint?.kind, "interrupted");
});
```

- [ ] **Step 2: Run the suite to verify it still fails cleanly (the source still has the mapping)**

Run: `cd web && node --test tests/lib/job-error-hint.test.mjs`
Expected: PASS — this step is descriptive only (removing tests can't newly fail anything); it confirms the remaining 14 tests are unaffected before the source change.

- [ ] **Step 3: Remove the dead mapping from the source**

In `web/src/lib/job-error-hint.mjs`, find the header comment block:

```js
//   Connection dropped mid-stream, CLI never got a chance to fail -> "connection":
//     "Connection error"                                                  (job-store.tsx)
//   Page reload orphaned a running job -> "interrupted":
//     "Interrupted (page reloaded)"                                       (job-store.tsx restore effect)
//   Everything else (bad input, missing CV, no report written, etc.) -> null;
```

Replace with:

```js
//   Connection dropped mid-stream, CLI never got a chance to fail -> "connection":
//     "Connection error"                                                  (job-store.tsx)
//   Everything else (bad input, missing CV, no report written, etc.) -> null;
```

Find:

```js
const HINTS = {
  auth: { kind: "auth", text: "Sign your CLI in from Config, then re-run." },
  connection: { kind: "connection", text: "Lost connection to the local server — re-run." },
  interrupted: { kind: "interrupted", text: "The run was interrupted — re-run it." },
};
```

Replace with:

```js
const HINTS = {
  auth: { kind: "auth", text: "Sign your CLI in from Config, then re-run." },
  connection: { kind: "connection", text: "Lost connection to the local server — re-run." },
};
```

Find:

```js
  if (label === "Connection error") return HINTS.connection;
  if (label === "Interrupted (page reloaded)") return HINTS.interrupted;
  if (AUTH_PATTERN.test(label)) return HINTS.auth;
```

Replace with:

```js
  if (label === "Connection error") return HINTS.connection;
  if (AUTH_PATTERN.test(label)) return HINTS.auth;
```

- [ ] **Step 4: Run the suite to verify it still passes**

Run: `cd web && node --test tests/lib/job-error-hint.test.mjs`
Expected: PASS — 14 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git status --short
git add web/src/lib/job-error-hint.mjs web/tests/lib/job-error-hint.test.mjs
git status --short
git commit -m "$(cat <<'EOF'
chore(web): retire the dead page-reload error hint

"Interrupted (page reloaded)" can no longer be produced anywhere in
the app now that /api/run doesn't kill the agent on disconnect, and
"unknown"-status jobs never reach jobErrorHint anyway (it's gated on
status === "error"). Drop the mapping and its two tests.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Full unit test suite**

Run: `cd web && npm test`
Expected: all suites pass, including the new `run-stream-lifecycle.test.mjs` and the trimmed `job-error-hint.test.mjs`.

- [ ] **Step 3: Manual end-to-end check — STOP AND ASK FIRST**

This step starts a dev server and spawns a real agent CLI against a real job posting, which touches `reports/`, `data/applications.md`, and consumes the configured CLI's API quota. It may also try to bind the same port the other concurrently-running agent's dev server is using.

**Before running anything in this step:**
1. Check whether a dev server is already running (e.g. `lsof -i :3000` or `ps aux | grep next`). If one is, it may belong to the other agent's session — do not kill it or start a second one on the same port without asking.
2. Ask the user for an OK to (a) start (or reuse) a dev server and (b) run one real "Evaluate" against a URL they choose, before doing either.

Once confirmed, the check is:
1. Start the dev server if needed: `cd web && npm run dev` (or confirm the existing one is fine to use).
2. From the UI, paste a real job-posting URL and click Evaluate.
3. While it's running, reload the tab.
4. In a terminal, confirm the agent process is still alive: `ps aux | grep -i <cli-binary-name>` (the configured CLI, e.g. `claude`).
5. Wait for it to finish; confirm `reports/` has the new report file and `data/applications.md` has the new tracker row — with the tab having been reloaded partway through and nobody watching.
6. Reload the tab again (or open `/jobs`) and confirm the job shows as `"unknown"` with the new copy, not `"error"`.

- [ ] **Step 4: Report results**

No commit for this task — it's verification only. Summarize the outcome (pass/fail per sub-step) back to the user.

---

## Self-Review

- **Spec coverage:** `run-stream-lifecycle.mjs` (spec §1) → Task 1. `route.ts` wiring (spec §2) → Task 2. `job-store.tsx` status type + restore effect (spec §3) → Task 3. Three UI surfaces (spec §4) → Task 4. `job-error-hint.mjs` cleanup (spec §5) → Task 5. Spec's testing section → Tasks 1, 5 (automated) and Task 6 (manual). Spec's "out of scope" items (live reattachment, server-restart survival) have no corresponding task, correctly — they're explicitly not being built.
- **Placeholder scan:** no TBD/TODO; every step shows the actual code, not a description of it.
- **Type consistency:** `createRunLifecycle()` and its five methods (`isStreamClosed`, `isSettled`, `onDisconnect`, `onStreamWriteFailed`, `settleOnce`) are defined once in Task 1 and used with identical names in Task 2 — checked against each call site above. `Job["status"]`'s new `"unknown"` member (Task 3) is consumed with the identical string literal in all three Task 4 files.
- **Scope check:** single subsystem (the run-stream lifecycle + its UI reflection), six tasks, each independently committable and each leaving the app in a working state. No decomposition into separate plans needed.
