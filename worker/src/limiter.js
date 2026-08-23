import {
  GATEWAY_MARKER_HEADER,
  GATEWAY_MARKER_VALUE
} from "./config.js";

export const RATE_LIMIT = 10;
export const RATE_WINDOW_MS = 60_000;

const SLOT_NAMES = ["1", "2", "3", "4"];
const COORDINATOR_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  [GATEWAY_MARKER_HEADER]: GATEWAY_MARKER_VALUE
};

export function createEmptyLimiterState() {
  return {
    "1": [],
    "2": [],
    "3": [],
    "4": []
  };
}

export function normalizeLimiterState(value) {
  const result = createEmptyLimiterState();

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return result;
  }

  for (const slot of SLOT_NAMES) {
    if (!Array.isArray(value[slot])) continue;
    result[slot] = value[slot].filter(
      timestamp => Number.isFinite(timestamp) && timestamp >= 0
    );
  }

  return result;
}

export function reserveInState(storedState, slot, now) {
  const slotName = String(slot);
  if (!SLOT_NAMES.includes(slotName) || !Number.isFinite(now)) {
    throw new TypeError("Invalid limiter reservation input.");
  }

  const state = normalizeLimiterState(storedState);
  const cutoff = now - RATE_WINDOW_MS;

  for (const name of SLOT_NAMES) {
    state[name] = state[name].filter(timestamp => timestamp >= cutoff);
  }

  const queue = state[slotName];
  if (queue.length < RATE_LIMIT) {
    queue.push(now);
    return {
      allowed: true,
      retryAfterMs: 0,
      state
    };
  }

  const oldest = Math.min(...queue);
  return {
    allowed: false,
    retryAfterMs: Math.max(1, oldest + RATE_WINDOW_MS - now + 1),
    state
  };
}

export class RateCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.now = () => Date.now();

    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS limiter_state (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)"
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO limiter_state (id, value) VALUES (1, ?)",
        JSON.stringify(createEmptyLimiterState())
      );
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/reserve") {
      return new Response(null, {
        status: request.method === "POST" ? 404 : 405,
        headers: COORDINATOR_RESPONSE_HEADERS
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "invalid_request" },
        { status: 400, headers: COORDINATOR_RESPONSE_HEADERS }
      );
    }

    const slot = String(body?.slot || "");
    if (!SLOT_NAMES.includes(slot) || Object.keys(body || {}).length !== 1) {
      return Response.json(
        { error: "invalid_slot" },
        { status: 400, headers: COORDINATOR_RESPONSE_HEADERS }
      );
    }

    let decision;
    this.ctx.storage.transactionSync(() => {
      const rows = [
        ...this.ctx.storage.sql.exec(
          "SELECT value FROM limiter_state WHERE id = 1"
        )
      ];

      if (!rows[0]?.value) {
        throw new Error("Limiter state is unavailable.");
      }

      let stored;
      try {
        stored = JSON.parse(rows[0].value);
      } catch {
        throw new Error("Limiter state is invalid.");
      }

      decision = reserveInState(stored, slot, this.now());

      this.ctx.storage.sql.exec(
        "UPDATE limiter_state SET value = ? WHERE id = 1",
        JSON.stringify(decision.state)
      );
    });

    return Response.json(
      {
        allowed: decision.allowed,
        retryAfterMs: decision.retryAfterMs
      },
      { headers: COORDINATOR_RESPONSE_HEADERS }
    );
  }
}
