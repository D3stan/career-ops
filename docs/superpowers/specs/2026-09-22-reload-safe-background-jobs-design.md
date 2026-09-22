# Reload-safe background evaluation jobs — design

- Status: approved, not yet implemented
- Author: Claude (career-ops session), for Alessandro
- Date: 2026-09-22

## Problem

`career-ops web` (the Next.js app in `web/`) runs a job evaluation ("Evaluate"
→ `kind: "evaluate"`) as an agent CLI process spawned inside a single streamed
HTTP request/response (`POST /api/run`). The client (`job-store.tsx`) opens the
stream with `fetch()` and reads it with a `ReadableStream` reader; the server
(`web/src/app/api/run/route.ts`) returns a `ReadableStream` whose `cancel()`
callback fires whenever that HTTP connection goes away.

Today, `cancel()` does this:

```js
cancel() {
  closed = true;
  if (heartbeat) clearInterval(heartbeat);
  if (killer) clearTimeout(killer);
  try { child.kill("SIGTERM"); } catch { /* ignore */ }
  ...
}
```

`child` is the actual agent CLI process doing the evaluation (reading the
profile, fetching the JD, scoring Blocks A–F+G, writing `reports/NNN-....md`,
merging the tracker row). Reloading or closing the browser tab aborts the
in-flight `fetch()`, which the Node/Next.js server sees as the client
disconnecting, which fires `cancel()`, which sends `SIGTERM` directly to the
agent. There is no detached/queued execution for `kind: "evaluate"` — the
whole job dies with the connection. The client's own restore-on-load logic in
`job-store.tsx` confirms this is a known, accepted (if unwanted) consequence:
any job still `status: "running"` when a fresh page load reads it back out of
`localStorage` is immediately relabeled `"error"` / *"Interrupted (page
reloaded)"*.

Alessandro runs this web app on a VPS (outside its documented "local-first,
runs entirely on your machine" design point — see `web/README.md`), reached
from a browser that may reload, lose connectivity, or simply be closed while
an evaluation is still running. He wants evaluations to survive that.

## Scope (from clarifying questions)

Two questions were asked and answered before this design was written:

1. **Desired behavior after disconnect:** fire-and-forget. The job finishes on
   the VPS regardless of the browser; on return, the user checks the
   Pipeline/Tracker/Workers pages for the result rather than re-attaching to a
   live progress feed. (Live reattachment from a second device was explicitly
   declined — that would need a persisted event log + a new streaming/status
   endpoint, out of scope here.)
2. **Restart survival:** browser tab reload/close only. A full web **server**
   process restart (deploy, `pm2 restart`, crash, `docker compose restart`)
   killing an in-flight job remains an accepted limitation — out of scope.
   (That would need the child spawned `detached` and independently
   discoverable after the server comes back up.)

## Chosen approach

Decouple the job's lifetime from the HTTP stream: a browser disconnect stops
the *stream* (nothing more gets written to the dead connection) but must not
touch the *job* (the child process, the 780s/600s safety-net timeout, or the
tracker write-token). The job's own process lifecycle — `child.on("close")`,
`child.on("error")`, or the safety-net timer finally firing — is the only
thing allowed to end the job and release its resources.

### Rejected alternative

Route "Evaluate" through the existing async pipeline (`data/pipeline.md` +
a scheduled background `pipeline` mode run via cron/pm2/systemd, per
`docs/AUTOMATION.md`) instead of a live-streamed spawn. Rejected because it
changes the interactive "paste a URL, click Evaluate" UX into "queued, runs on
the next scheduled sweep," which is a materially different (and worse, for
this use case) experience than what's broken today. It remains a good fit for
*unattended* scanning automation, just not for this flow.

## Design

### 1. New: `web/src/lib/core/run-stream-lifecycle.mjs`

A small, pure, unit-testable module replacing the single `closed` boolean
currently used in `route.ts`'s per-run stream closure. It separates two
previously-conflated concerns:

- **`streamClosed`** — can we still write to the browser's HTTP stream? Goes
  `true` on disconnect, or the first time an `enqueue()` fails on its own.
- **`settled`** — has the job's real cleanup happened (release the tracker
  write-token, clear the safety-net kill timer, close the controller if it
  isn't already)? Goes `true` exactly once, only when the underlying process
  actually finishes.

```js
export function createRunLifecycle() {
  let streamClosed = false;
  let settled = false;
  return {
    isStreamClosed: () => streamClosed,
    isSettled: () => settled,
    /** Browser/client went away. The job is unaffected. */
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

This mirrors the existing style of `web/src/lib/core/run-registry.ts` — small,
single-purpose, with the "why" written down so the next person doesn't have to
reconstruct it from a bug tracker.

### 2. `web/src/app/api/run/route.ts`

- Replace the closure-local `let closed = false;` with `const lifecycle =
  createRunLifecycle();` and thread `lifecycle.isStreamClosed()` /
  `lifecycle.isSettled()` through the places that currently read `closed`.
- `send()` checks `lifecycle.isStreamClosed()` instead of `closed`; on a caught
  `enqueue()` failure it calls `lifecycle.onStreamWriteFailed()` (plus still
  clears `heartbeat`, unchanged).
- `close()` (the existing helper, still the single place that performs real
  cleanup) becomes a thin wrapper around `lifecycle.settleOnce(...)`:
  ```js
  const close = () => {
    lifecycle.settleOnce(() => {
      if (heartbeat) clearInterval(heartbeat);
      if (killer) clearTimeout(killer);
      releaseWriteTokenOnce();
      try { controller.close(); } catch { /* */ }
    });
  };
  ```
- `child.stdout.on("data", ...)`'s early `if (closed) return;` is **removed**.
  Parsing continues after disconnect so `emittedText`/`sawError`/token
  accounting stay correct for the eventual close-time honesty gate, and so
  pdf mode's `cvFilter` still sees the entire `<<cv-html>>` envelope even if
  the browser left partway through. The downstream `send()`/`sendAgentText()`
  calls are already no-ops once `streamClosed` is true, so this costs nothing
  extra once disconnected.
- `child.on("close", (code) => { ... })`'s guard changes from `if (closed)
  return;` to `if (lifecycle.isSettled()) return;` — it still runs its full
  honesty-gate logic (`noOutputError`, `wroteReport`, `cleanExit`) and settles
  for real when the process actually finishes, even with nobody listening; it
  only short-circuits if `child.on("error")` already settled things first.
- `child.on("error", (e) => { send(...); close(); })` is unchanged in shape
  (still calls the now-`lifecycle`-backed `close()`).
- `killer` (the `killMs`-based `setTimeout` that SIGTERMs a hung agent) is
  **unchanged in creation**, but `cancel()` no longer clears it — see below.
  It remains the only backstop against a runaway process once nobody's
  watching.
- `renderPdf(...)`'s `finally { close(); }` is unchanged in shape.
- **`cancel()` becomes:**
  ```js
  cancel() {
    lifecycle.onDisconnect();
    if (heartbeat) clearInterval(heartbeat);
    // Deliberately do NOT kill `child`, clear `killer`, or release the
    // write-token here. A disconnect only means the browser stopped
    // listening — the job keeps running and settles for real via its own
    // close()/error() path (or the killer timeout) above.
  },
  ```
  It no longer references `pdfRenderPromise` at all — the pdf agent-tailoring
  phase now survives a disconnect the same way `evaluate` does, and the
  existing `pdfRenderPromise` deferred-release logic inside the pdf branch of
  `child.on("close")` is untouched (it already does the right thing once
  reached).

### 3. Client — `web/src/components/jobs/job-store.tsx`

- Extend the `Job["status"]` union: `"running" | "done" | "error" | "unknown"`.
- Change the restore-from-`localStorage` effect: a job found `status:
  "running"` on a fresh load is no longer asserted to have failed. It becomes:
  ```js
  status: "unknown",
  steps: [...(j.steps || []), {
    kind: "status",
    label: "Reload closed this tab's view — the evaluation kept running on the server. Check Pipeline for the result.",
    ts: Date.now(),
  }],
  ```

### 4. UI surfaces keyed on `job.status`

Three places currently branch on status with an implicit "anything that's not
running/done is an error" assumption. Each needs an explicit, neutral
`"unknown"` branch so it isn't misrendered as a failure:

- `web/src/components/jobs/worker-card.tsx` — the icon ternary
  (`running` → spinner, `error` → triangle, else → check) gets a third
  explicit branch for `unknown` (a neutral icon, muted tone). `pillTone()`
  already defaults anything that isn't `"error"`/`"done"` to `"muted"`, so it
  needs no change.
- `web/src/app/jobs/page.tsx` — same icon-ternary shape, same fix. The raw
  `{j.status}` text label (`capitalize`d) already renders `"unknown"`
  correctly with no change needed.
- `web/src/app/jobs/[id]/page.tsx` — the header pill ternary currently treats
  anything that isn't `running`/`done` as `error` (red `X`, "error" text).
  Needs an explicit fourth branch.

### 5. `web/src/lib/job-error-hint.mjs`

Delete the `"Interrupted (page reloaded)" → HINTS.interrupted` mapping and its
line in the header comment's classification table. That terminal label can no
longer be produced anywhere in the app once (3) lands. `"unknown"`-status jobs
never reach this function regardless, since `lastStepLabel()` already
early-returns `""` for any `job.status !== "error"`.

## Data flow after the fix

1. User pastes a URL, clicks Evaluate → `POST /api/run` (`kind: "evaluate"`) →
   server spawns the agent CLI.
2. Server streams progress; client renders it live — unchanged from today.
3. User reloads mid-run:
   - Browser aborts the `fetch()` → the `ReadableStream`'s `cancel()` fires.
   - `cancel()` now only stops talking to the dead connection
     (`lifecycle.onDisconnect()` + clearing the now-pointless heartbeat). The
     agent process is untouched and keeps running under the Node server.
   - The agent finishes normally (or hits the safety-net timeout if it truly
     hangs) — writes `reports/NNN-....md`, merges the tracker row, exits.
     `child.on("close")` runs its full honesty-gate logic and settles for
     real — release the write-token, clear the killer — entirely server-side,
     no client involved.
4. New page load: `JobsProvider` restores the job list from `localStorage`,
   finds the stale `"running"` entry, relabels it `"unknown"` with the honest
   copy above. The user opens `/pipeline` or `/jobs` and the evaluated row /
   report is simply there — the tracker file is the source of truth, exactly
   as it is for anyone visiting the app fresh.

## Error handling / edge cases

- A genuinely hung agent (no reload involved at all) is still bounded by
  `killMs` — this path is untouched by the fix.
- No dual-attachment risk: each `startJob()` call creates a brand-new job id
  and a brand-new `POST`/spawn. There is no "resume the old stream" path, so
  two browser connections can never end up attached to the same child.
- The tracker-write-token race that `run-registry.ts` exists to prevent
  (`tracker.mjs delete` vs. an in-flight `merge-tracker.mjs`) is, if anything,
  *more* correctly guarded after this change than before: today a disconnect
  releases the token immediately, before the child is guaranteed to have
  actually stopped writing — a latent race. After this change the token is
  held for the process's true lifetime, always.
- `kind: "pdf"`: the render+mark phase's existing `pdfRenderPromise`-deferred
  release is unchanged. What *does* change for pdf is that the earlier
  agent-tailoring phase (before `pdfRenderPromise` exists) no longer gets
  killed on disconnect either — it now survives exactly like `evaluate` does,
  which is a strict improvement (previously a disconnect during CV tailoring
  silently discarded the tailoring work).
- Self-hosted (`next start` on a VPS) note, not a code change: Next.js's
  `maxDuration` route config has no enforcement outside Vercel-style
  serverless hosting, so on this deployment there is no other hidden timeout
  that could still kill the child after this fix — `killer` is the only
  backstop, by design.

## Testing

- New `web/tests/lib/run-stream-lifecycle.test.mjs` (Node's `node:test`,
  matching `web/tests/`'s existing convention) unit-tests the extracted state
  machine directly:
  - disconnect alone does not settle
  - `settleOnce` runs its callback exactly once, even if called again after
    disconnect
  - calling `settleOnce` before any disconnect still marks the stream closed
  - disconnect after settle is a no-op (doesn't re-run cleanup)
- Trim `web/tests/lib/job-error-hint.test.mjs`: remove the two tests keyed to
  the now-retired `"Interrupted (page reloaded)"` label (the "page-reload
  interruption -> interrupted hint" test and the
  "interrupted with unrelated auth-flavored assistant text" test).
- `npx tsc --noEmit` and `npm test` (full existing web suite) to catch any
  other code that assumed the old single-`closed` behavior.
- Manual end-to-end verification (can't be meaningfully unit-tested — needs a
  real spawned CLI and a real HTTP disconnect): `npm run dev`, click Evaluate
  on a real posting, reload the tab partway through, confirm via `ps` that the
  agent process is still alive after the reload, and confirm `reports/` and
  `data/applications.md` are updated once it finishes — with nobody watching
  the tab.

## Out of scope (explicitly, per the clarifying answers)

- Live reattachment to a running job's progress stream after reload or from a
  second device (would need a persisted event log + a status/tail endpoint).
- Surviving a full web server process restart (would need `detached` spawning
  and a job registry that outlives the Node process).
