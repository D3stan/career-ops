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
