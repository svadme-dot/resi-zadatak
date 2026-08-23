import { reserveInState, createEmptyLimiterState } from "../src/limiter.js";

export const ALLOWED_ORIGIN = "https://svadme-dot.github.io";

export function validPublicBody(overrides = {}) {
  return {
    input: [{ type: "text", text: "Reši jednačinu 2x + 3 = 9." }],
    stream: false,
    ...overrides
  };
}

export function makeRequest({
  body = validPublicBody(),
  method = "POST",
  origin = ALLOWED_ORIGIN,
  slot = "1",
  path = "/v1/interactions",
  headers = {},
  signal
} = {}) {
  const requestHeaders = new Headers(headers);
  if (origin !== null) requestHeaders.set("Origin", origin);
  if (slot !== null) requestHeaders.set("X-Math-Api-Slot", slot);
  if (body !== null && !requestHeaders.has("Content-Type")) {
    requestHeaders.set("Content-Type", "application/json");
  }

  return new Request(`https://worker.example${path}`, {
    method,
    headers: requestHeaders,
    body: body === null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    signal
  });
}

export function makeRateBinding(now = () => Date.now()) {
  let state = createEmptyLimiterState();
  const calls = [];

  return {
    calls,
    idFromName(name) {
      calls.push({ type: "id", name });
      return `id:${name}`;
    },
    get(id) {
      calls.push({ type: "get", id });
      return {
        async fetch(_url, init) {
          const { slot } = JSON.parse(init.body);
          const decision = reserveInState(state, slot, now());
          state = decision.state;
          calls.push({ type: "reserve", slot, allowed: decision.allowed });
          return Response.json({
            allowed: decision.allowed,
            retryAfterMs: decision.retryAfterMs
          });
        }
      };
    }
  };
}

export function makeEnv(overrides = {}) {
  return {
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    UPSTREAM_TIMEOUT_MS: "120000",
    GEMINI_API_KEY_1: "canary-secret-slot-1",
    GEMINI_API_KEY_2: "canary-secret-slot-2",
    GEMINI_API_KEY_3: "canary-secret-slot-3",
    GEMINI_API_KEY_4: "canary-secret-slot-4",
    RATE_COORDINATOR: makeRateBinding(() => 10_000),
    ...overrides
  };
}

export function completedInteraction(answer = "x = 3") {
  return {
    id: "interaction-1",
    status: "completed",
    steps: [
      {
        type: "thought",
        summary: [{ type: "text", text: "Kratka provera." }]
      },
      {
        type: "model_output",
        content: [{ type: "text", text: answer }]
      }
    ]
  };
}

export function syncSuccess(answer) {
  return new Response(JSON.stringify(completedInteraction(answer)), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

export async function streamToText(stream) {
  return new Response(stream).text();
}
