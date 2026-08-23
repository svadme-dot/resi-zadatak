import test from "node:test";
import assert from "node:assert/strict";

import {
  RATE_LIMIT,
  RATE_WINDOW_MS,
  RateCoordinator,
  createEmptyLimiterState,
  reserveInState
} from "../src/limiter.js";

const GATEWAY_MARKER_HEADER = "X-Math-Gateway";

test("rolling limiter allows 10 calls and rejects the 11th", () => {
  let state = createEmptyLimiterState();

  for (let index = 0; index < RATE_LIMIT; index++) {
    const decision = reserveInState(state, "1", 1_000);
    state = decision.state;
    assert.equal(decision.allowed, true);
  }

  const denied = reserveInState(state, "1", 1_000);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, RATE_WINDOW_MS + 1);
  assert.equal(denied.state["1"].length, RATE_LIMIT);
});

test("strict rolling boundary retains timestamps at exactly now - 60 seconds", () => {
  let state = createEmptyLimiterState();
  for (let index = 0; index < RATE_LIMIT; index++) {
    const decision = reserveInState(state, "1", 5_000);
    state = decision.state;
  }

  const exactBoundary = reserveInState(
    state,
    "1",
    5_000 + RATE_WINDOW_MS
  );
  assert.equal(exactBoundary.allowed, false);
  assert.equal(exactBoundary.retryAfterMs, 1);

  const oneMillisecondLater = reserveInState(
    exactBoundary.state,
    "1",
    5_001 + RATE_WINDOW_MS
  );
  assert.equal(oneMillisecondLater.allowed, true);
  assert.deepEqual(oneMillisecondLater.state["1"], [65_001]);
});

test("all four slot queues are isolated", () => {
  let state = createEmptyLimiterState();

  for (const slot of ["1", "2", "3", "4"]) {
    for (let index = 0; index < RATE_LIMIT; index++) {
      const decision = reserveInState(state, slot, 2_000);
      state = decision.state;
      assert.equal(decision.allowed, true);
    }
  }

  for (const slot of ["1", "2", "3", "4"]) {
    assert.equal(reserveInState(state, slot, 2_000).allowed, false);
  }
});

class FakeSql {
  constructor() {
    this.value = null;
  }

  exec(query, ...bindings) {
    if (query.startsWith("CREATE TABLE")) return [];
    if (query.startsWith("INSERT OR IGNORE")) {
      if (this.value === null) this.value = bindings[0];
      return [];
    }
    if (query.startsWith("SELECT value")) {
      return this.value === null ? [] : [{ value: this.value }];
    }
    if (query.startsWith("UPDATE limiter_state")) {
      this.value = bindings[0];
      return [];
    }
    throw new Error(`Unexpected SQL in fake storage: ${query}`);
  }
}

function makeFakeContext(sql) {
  const context = {
    transactionCount: 0,
    storage: {
      sql,
      transactionSync(callback) {
        context.transactionCount += 1;
        return callback();
      }
    },
    blockConcurrencyWhile(callback) {
      context.ready = Promise.resolve(callback());
      return context.ready;
    }
  };
  return context;
}

function reservationRequest(slot = "1") {
  return new Request("https://coordinator.internal/reserve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slot })
  });
}

test("concurrent Durable Object reservations use one transaction each and allow exactly 10", async () => {
  const sql = new FakeSql();
  const context = makeFakeContext(sql);
  const coordinator = new RateCoordinator(context, {});
  coordinator.now = () => 20_000;
  await context.ready;

  const responses = await Promise.all(
    Array.from({ length: 50 }, () => coordinator.fetch(reservationRequest()))
  );
  const decisions = await Promise.all(responses.map(response => response.json()));

  assert.equal(
    responses.every(response => response.headers.get(GATEWAY_MARKER_HEADER) === "1"),
    true
  );
  assert.equal(decisions.filter(item => item.allowed).length, RATE_LIMIT);
  assert.equal(decisions.filter(item => !item.allowed).length, 40);
  assert.equal(context.transactionCount, 50);
  assert.equal(JSON.parse(sql.value)["1"].length, RATE_LIMIT);
});

test("Durable Object state survives a new class instance", async () => {
  const sql = new FakeSql();
  const firstContext = makeFakeContext(sql);
  const first = new RateCoordinator(firstContext, {});
  first.now = () => 30_000;
  await firstContext.ready;

  for (let index = 0; index < RATE_LIMIT; index++) {
    const response = await first.fetch(reservationRequest("3"));
    assert.equal((await response.json()).allowed, true);
  }

  const secondContext = makeFakeContext(sql);
  const second = new RateCoordinator(secondContext, {});
  second.now = () => 30_000;
  await secondContext.ready;
  const denied = await second.fetch(reservationRequest("3"));

  assert.equal((await denied.json()).allowed, false);
});

test("invalid persisted limiter state fails closed instead of resetting usage", async () => {
  const sql = new FakeSql();
  sql.value = "not-json";
  const context = makeFakeContext(sql);
  const coordinator = new RateCoordinator(context, {});
  coordinator.now = () => 30_000;
  await context.ready;

  await assert.rejects(
    () => coordinator.fetch(reservationRequest("1")),
    /Limiter state is invalid/
  );
});
