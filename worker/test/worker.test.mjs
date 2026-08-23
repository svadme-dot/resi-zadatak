import test from "node:test";
import assert from "node:assert/strict";

import {
  SYSTEM_INSTRUCTION,
  UPSTREAM_INTERACTIONS_URL,
  UPSTREAM_MODEL
} from "../src/config.js";
import { handleRequest } from "../src/index.js";
import {
  ALLOWED_ORIGIN,
  completedInteraction,
  makeEnv,
  makeRateBinding,
  makeRequest,
  syncSuccess,
  validPublicBody
} from "./helpers.mjs";

const GATEWAY_MARKER_HEADER = "X-Math-Gateway";

function assertHealthyGateway(response) {
  assert.equal(response.headers.get(GATEWAY_MARKER_HEADER), "1");
}

test("health is neutral and fixed routes and methods are enforced", async () => {
  const env = makeEnv();
  const health = await handleRequest(
    new Request("https://worker.example/health"),
    env,
    {}
  );
  assert.equal(health.status, 200);
  assertHealthyGateway(health);
  assert.deepEqual(await health.json(), { ok: true });

  const browserHealth = await handleRequest(
    new Request("https://worker.example/health", {
      headers: { Origin: ALLOWED_ORIGIN }
    }),
    env,
    {}
  );
  assert.equal(browserHealth.status, 200);
  assertHealthyGateway(browserHealth);
  assert.equal(
    browserHealth.headers.get("Access-Control-Allow-Origin"),
    ALLOWED_ORIGIN
  );
  assert.match(
    browserHealth.headers.get("Access-Control-Expose-Headers"),
    /(?:^|,\s*)X-Math-Gateway(?:\s*,|$)/i
  );

  const missing = await handleRequest(
    makeRequest({ path: "/anything" }),
    env,
    {}
  );
  assert.equal(missing.status, 404);
  assertHealthyGateway(missing);

  const method = await handleRequest(
    makeRequest({ method: "PUT", body: "{}" }),
    env,
    {}
  );
  assert.equal(method.status, 405);
  assertHealthyGateway(method);
  assert.equal(method.headers.get("Allow"), "POST, OPTIONS");
});

test("allowed preflight returns narrow CORS policy without credentials or wildcard", async () => {
  const request = new Request(
    "https://worker.example/v1/interactions",
    {
      method: "OPTIONS",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, x-math-api-slot"
      }
    }
  );
  const response = await handleRequest(request, makeEnv(), {});

  assert.equal(response.status, 204);
  assertHealthyGateway(response);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ALLOWED_ORIGIN);
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "Content-Type, X-Math-Api-Slot");
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);
  assert.match(
    response.headers.get("Access-Control-Expose-Headers"),
    /(?:^|,\s*)X-Math-Gateway(?:\s*,|$)/i
  );
  assert.notEqual(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(response.headers.get("Vary"), /Origin/);
});

test("CORS fails closed for missing, lookalike, insecure, and unconfigured origins", async () => {
  for (const origin of [
    null,
    "null",
    "http://svadme-dot.github.io",
    "https://svadme-dot.github.io.evil.example"
  ]) {
    const response = await handleRequest(
      makeRequest({ origin }),
      makeEnv(),
      {},
      { fetchImpl: async () => syncSuccess() }
    );
    assert.equal(response.status, 403, String(origin));
    assertHealthyGateway(response);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  }

  const unconfigured = await handleRequest(
    makeRequest(),
    makeEnv({ ALLOWED_ORIGINS: "" }),
    {},
    { fetchImpl: async () => syncSuccess() }
  );
  assert.equal(unconfigured.status, 403);
  assertHealthyGateway(unconfigured);
});

test("preflight rejects credential headers and a non-POST method", async () => {
  for (const headers of [
    {
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type, authorization"
    },
    {
      "Access-Control-Request-Method": "DELETE",
      "Access-Control-Request-Headers": "content-type"
    }
  ]) {
    const response = await handleRequest(
      new Request("https://worker.example/v1/interactions", {
        method: "OPTIONS",
        headers: { Origin: ALLOWED_ORIGIN, ...headers }
      }),
      makeEnv(),
      {}
    );
    assert.equal(response.status, 403);
    assertHealthyGateway(response);
  }
});

test("gateway injects the exact fixed model policy and sends only the selected server secret", async () => {
  const input = [{ type: "text", text: "Sačuvaj ovaj tekst 1:1." }];
  const calls = [];
  const response = await handleRequest(
    makeRequest({
      slot: "2",
      body: {
        input,
        stream: false,
        previous_interaction_id: "previous-2"
      }
    }),
    makeEnv(),
    {},
    {
      async fetchImpl(url, init) {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return syncSuccess("Tačan odgovor.");
      }
    }
  );

  assert.equal(response.status, 200);
  assertHealthyGateway(response);
  assert.match(
    response.headers.get("Access-Control-Expose-Headers"),
    /(?:^|,\s*)X-Math-Gateway(?:\s*,|$)/i
  );
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, UPSTREAM_INTERACTIONS_URL);
  assert.equal(call.init.headers["x-goog-api-key"], "canary-secret-slot-2");
  assert.equal(call.init.headers.Accept, "application/json");
  assert.equal(call.init.redirect, "error");
  assert.equal(call.body.model, UPSTREAM_MODEL);
  assert.strictEqual(call.body.model, "gemini-3.6-flash");
  assert.deepEqual(call.body.input, input);
  assert.equal(call.body.store, true);
  assert.equal(call.body.system_instruction, SYSTEM_INSTRUCTION);
  assert.deepEqual(call.body.tools, [{ type: "code_execution" }]);
  assert.deepEqual(call.body.generation_config, {
    thinking_level: "high",
    thinking_summaries: "auto"
  });
  assert.equal(call.body.previous_interaction_id, "previous-2");
  assert.doesNotMatch(call.init.body, /canary-secret-slot/);
  assert.doesNotMatch(response.headers.toString(), /canary-secret-slot/i);
  assert.doesNotMatch(await response.text(), /canary-secret-slot/i);
});

test("browser model/key/config injection and credential headers are rejected before reservation", async () => {
  let upstreamCalls = 0;
  const rate = makeRateBinding(() => 1_000);
  const env = makeEnv({ RATE_COORDINATOR: rate });

  for (const body of [
    { ...validPublicBody(), model: "attacker-model" },
    { ...validPublicBody(), api_key: "browser-key" },
    { ...validPublicBody(), upstream_url: "https://evil.example" }
  ]) {
    const response = await handleRequest(
      makeRequest({ body }),
      env,
      {},
      {
        fetchImpl: async () => {
          upstreamCalls += 1;
          return syncSuccess();
        }
      }
    );
    assert.equal(response.status, 400);
  }

  const credentialRequest = makeRequest({
    headers: { "x-goog-api-key": "browser-key" }
  });
  const credentialResponse = await handleRequest(
    credentialRequest,
    env,
    {},
    { fetchImpl: async () => syncSuccess() }
  );
  assert.equal(credentialResponse.status, 400);
  assert.equal(upstreamCalls, 0);
  assert.equal(rate.calls.filter(call => call.type === "reserve").length, 0);
});

test("method, media type, slot, and JSON validation fail before limiter/upstream", async () => {
  const rate = makeRateBinding(() => 1_000);
  const env = makeEnv({ RATE_COORDINATOR: rate });
  let upstreamCalls = 0;
  const fetchImpl = async () => {
    upstreamCalls += 1;
    return syncSuccess();
  };

  const requests = [
    makeRequest({ headers: { "Content-Type": "text/plain" } }),
    makeRequest({ slot: "5" }),
    makeRequest({ body: "{" }),
    makeRequest({ body: { input: [], stream: true } })
  ];

  const statuses = [];
  for (const request of requests) {
    statuses.push(
      (await handleRequest(request, env, {}, { fetchImpl })).status
    );
  }
  assert.deepEqual(statuses, [415, 400, 400, 400]);
  assert.equal(upstreamCalls, 0);
  assert.equal(rate.calls.filter(call => call.type === "reserve").length, 0);
});

test("each slot gets 10 upstream calls, then its 11th is denied with Retry-After", async () => {
  let now = 50_000;
  const rate = makeRateBinding(() => now);
  const env = makeEnv({ RATE_COORDINATOR: rate });
  const callsBySlot = { "1": 0, "2": 0, "3": 0, "4": 0 };
  const fetchImpl = async (_url, init) => {
    const secret = init.headers["x-goog-api-key"];
    const slot = secret.at(-1);
    callsBySlot[slot] += 1;
    return syncSuccess();
  };

  for (const slot of ["1", "2", "3", "4"]) {
    for (let index = 0; index < 10; index++) {
      const response = await handleRequest(
        makeRequest({ slot }),
        env,
        {},
        { fetchImpl }
      );
      assert.equal(response.status, 200);
    }
    const denied = await handleRequest(
      makeRequest({ slot }),
      env,
      {},
      { fetchImpl }
    );
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get("Retry-After"), "61");
    assert.equal(denied.headers.get("Access-Control-Allow-Origin"), ALLOWED_ORIGIN);
    assert.doesNotMatch(await denied.text(), /gemini|google|canary-secret/i);
  }

  assert.deepEqual(callsBySlot, { "1": 10, "2": 10, "3": 10, "4": 10 });
  assert.equal(
    rate.calls.filter(call => call.type === "id").every(call => call.name === "global"),
    true
  );
});

test("limiter failure is fail-closed and never calls upstream", async () => {
  let upstreamCalls = 0;
  const env = makeEnv({
    RATE_COORDINATOR: {
      idFromName() {
        return "global";
      },
      get() {
        return {
          async fetch() {
            throw new Error("storage unavailable with canary-secret-slot-1");
          }
        };
      }
    }
  });

  const response = await handleRequest(
    makeRequest(),
    env,
    {},
    {
      fetchImpl: async () => {
        upstreamCalls += 1;
        return syncSuccess();
      }
    }
  );

  assert.equal(response.status, 503);
  assert.equal(upstreamCalls, 0);
  assert.doesNotMatch(await response.text(), /canary-secret|storage unavailable/i);
});

test("upstream non-2xx responses preserve useful status while sanitizing all details", async () => {
  const cases = [
    [401, 401, "authentication_failed"],
    [403, 403, "permission_denied"],
    [429, 429, "upstream_rate_limited"],
    [500, 500, "upstream_unavailable"],
    [503, 503, "upstream_unavailable"]
  ];

  for (const [upstreamStatus, expectedStatus, code] of cases) {
    const response = await handleRequest(
      makeRequest(),
      makeEnv(),
      {},
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              error: {
                message:
                  "Google Gemini gemini-3.6-flash at generativelanguage.googleapis.com " +
                  "leaked canary-secret-slot-1 and stack trace"
              }
            }),
            {
              status: upstreamStatus,
              headers: {
                "Content-Type": "application/json",
                "X-Goog-Request-Id": "provider-id",
                Server: "provider-server",
                "Set-Cookie": "secret=cookie"
              }
            }
          )
      }
    );

    assert.equal(response.status, expectedStatus);
    const publicText = await response.text();
    assert.equal(JSON.parse(publicText).error.code, code);
    assert.doesNotMatch(
      publicText + response.headers.toString(),
      /gemini|google|generativelanguage|canary-secret|stack trace|provider-id|provider-server|secret=cookie/i
    );
  }
});

test("capability and stale-continuation errors get neutral actionable classifications", async () => {
  const capability = await handleRequest(
    makeRequest(),
    makeEnv(),
    {},
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Image input modality is not enabled for models/gemini-3.6-flash-agent"
            }
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        )
    }
  );
  assert.equal(capability.status, 422);
  const capabilityBody = await capability.text();
  assert.match(capabilityBody, /image input modality/i);
  assert.doesNotMatch(capabilityBody, /gemini|3\.6/i);

  const stale = await handleRequest(
    makeRequest({
      body: { ...validPublicBody(), previous_interaction_id: "expired-1" }
    }),
    makeEnv(),
    {},
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: { message: "previous_interaction_id requested entity was not found" }
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        )
    }
  );
  assert.equal(stale.status, 404);
  assert.match(await stale.text(), /previous interaction.*expired/i);
});

test("400-class key, quota, demand, and permission failures map to fallback statuses", async () => {
  const cases = [
    ["API key not valid", 401, "authentication_failed"],
    ["RESOURCE_EXHAUSTED quota exceeded", 429, "upstream_rate_limited"],
    ["The service is experiencing high demand, try again", 503, "upstream_unavailable"],
    ["Project permission was denied", 403, "permission_denied"]
  ];

  for (const [rawMessage, expectedStatus, expectedCode] of cases) {
    const response = await handleRequest(
      makeRequest(),
      makeEnv(),
      {},
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: rawMessage } }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          })
      }
    );
    const body = await response.json();
    assert.equal(response.status, expectedStatus, rawMessage);
    assert.equal(body.error.code, expectedCode, rawMessage);
  }
});

test("ordinary 400 request messages are not broadened into fallback statuses", async () => {
  for (const rawMessage of [
    "Please try again with a valid equation.",
    "The project asks the student to calculate a temporary variable."
  ]) {
    const response = await handleRequest(
      makeRequest(),
      makeEnv(),
      {},
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: rawMessage } }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          })
      }
    );
    assert.equal(response.status, 400, rawMessage);
    assert.equal(
      (await response.json()).error.code,
      "upstream_request_rejected",
      rawMessage
    );
  }
});

test("streaming stays incremental and sanitizes branding in metadata and answer text", async () => {
  const answer = "Matematički sadržaj pominje Gemini 3.6 kao korisnički tekst.";
  let releaseSecond;
  const secondGate = new Promise(resolve => {
    releaseSecond = resolve;
  });
  const encoder = new TextEncoder();

  const responsePromise = handleRequest(
    makeRequest({ body: validPublicBody({ stream: true }) }),
    makeEnv(),
    {},
    {
      fetchImpl: async (url, init) => {
        assert.equal(url, `${UPSTREAM_INTERACTIONS_URL}?alt=sse`);
        assert.equal(init.headers.Accept, "text/event-stream");
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    event_type: "step.delta",
                    model: "gemini-3.6-flash",
                    delta: { type: "text", text: answer }
                  })}\n\n`
                )
              );
              await secondGate;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    event_type: "interaction.completed",
                    interaction: {
                      status: "failed",
                      model: "gemini-3.6-flash",
                      errors: [
                        {
                          code: "GEMINI_503",
                          message: "Google Gemini 3.6 high demand, canary-secret-slot-1"
                        }
                      ],
                      steps: completedInteraction(answer).steps
                    }
                  })}\n\n`
                )
              );
              controller.close();
            }
          }),
          { headers: { "Content-Type": "text/event-stream" } }
        );
      }
    }
  );

  const response = await responsePromise;
  assert.equal(response.status, 200);
  assertHealthyGateway(response);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream; charset=utf-8");
  const reader = response.body.getReader();
  const first = await reader.read();
  const firstText = new TextDecoder().decode(first.value);
  assert.match(firstText, /step\.delta/);
  assert.match(firstText, /Matematički sadržaj pominje AI service/);
  assert.doesNotMatch(firstText, /gemini|google|canary-secret/i);
  assert.doesNotMatch(firstText, /"model"/);

  releaseSecond();
  let rest = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    rest += new TextDecoder().decode(chunk.value);
  }
  assert.match(rest, /high demand/i);
  assert.doesNotMatch(
    JSON.stringify(JSON.parse(rest.match(/^data:\s*(.*)$/m)[1]).interaction.errors),
    /gemini|google|canary-secret/i
  );
  assert.match(rest, /Matematički sadržaj pominje AI service/);
  assert.doesNotMatch(rest, /gemini|google|canary-secret/i);
});

test("sync success strips metadata and neutralizes provider names in output text", async () => {
  const answer = "Odgovor korisniku sadrži reč Gemini i ostaje neizmenjen.";
  const interaction = completedInteraction(answer);
  interaction.model = "gemini-3.6-flash";
  interaction.provider = "Google";

  const response = await handleRequest(
    makeRequest(),
    makeEnv(),
    {},
    {
      fetchImpl: async () =>
        new Response(JSON.stringify(interaction), {
          headers: { "Content-Type": "application/json" }
        })
    }
  );
  const body = await response.json();

  assert.equal(body.model, undefined);
  assert.equal(body.provider, undefined);
  assert.equal(
    body.steps[1].content[0].text,
    "Odgovor korisniku sadrži reč AI service i ostaje neizmenjen."
  );
});

test("upstream timeout is sanitized and the reservation is not rolled back", async () => {
  const rate = makeRateBinding(() => 5_000);
  const env = makeEnv({ RATE_COORDINATOR: rate });
  const response = await handleRequest(
    makeRequest(),
    env,
    {},
    {
      timeoutMs: 10,
      fetchImpl: async (_url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal.reason),
            { once: true }
          );
        })
    }
  );

  assert.equal(response.status, 504);
  assert.equal(rate.calls.filter(call => call.type === "reserve").length, 1);
  assert.doesNotMatch(await response.text(), /gemini|google|canary-secret/i);
});

test("a timeout after streaming headers becomes a neutral retriable SSE error", async () => {
  const response = await handleRequest(
    makeRequest({ body: validPublicBody({ stream: true }) }),
    makeEnv(),
    {},
    {
      timeoutMs: 10,
      fetchImpl: async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal.addEventListener(
                "abort",
                () => controller.error(init.signal.reason),
                { once: true }
              );
            }
          }),
          { headers: { "Content-Type": "text/event-stream" } }
        )
    }
  );

  assert.equal(response.status, 200);
  const wire = await response.text();
  const payload = JSON.parse(wire.match(/^data:\s*(.*)$/m)[1]);
  assert.equal(payload.event_type, "error");
  assert.equal(payload.error.code, 504);
  assert.match(payload.error.message, /temporarily|timed out/i);
  assert.doesNotMatch(wire, /gemini|google|canary-secret/i);
});

test("client abort propagates to the active upstream request", async () => {
  const controller = new AbortController();
  let upstreamAborted = false;
  let markUpstreamStarted;
  const upstreamStarted = new Promise(resolve => {
    markUpstreamStarted = resolve;
  });
  const request = makeRequest({ signal: controller.signal });
  const responsePromise = handleRequest(
    request,
    makeEnv(),
    {},
    {
      timeoutMs: 10_000,
      fetchImpl: async (_url, init) =>
        new Promise((resolve, reject) => {
          markUpstreamStarted();
          init.signal.addEventListener(
            "abort",
            () => {
              upstreamAborted = true;
              reject(init.signal.reason);
            },
            { once: true }
          );
        })
    }
  );

  await upstreamStarted;
  controller.abort(new DOMException("user stopped", "AbortError"));
  const response = await responsePromise;
  assert.equal(response.status, 499);
  assert.equal(upstreamAborted, true);
});
