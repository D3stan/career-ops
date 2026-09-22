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
