import test from "node:test";
import assert from "node:assert/strict";

import {
  createSanitizedSseStream,
  sanitizePublicPayload,
  sanitizeSensitiveText,
  sanitizeSseText
} from "../src/sanitize.js";
import { streamToText } from "./helpers.mjs";

const SECRET = "canary-secret-slot-1";

test("sensitive error text removes secret, provider, model ID, domain, and credential header", () => {
  const raw =
    `Google Gemini 3.6 Flash models/gemini-3.6-flash at ` +
    `https://generativelanguage.googleapis.com/v1beta/interactions ` +
    `returned ${SECRET} in x-goog-api-key while experiencing high demand.`;
  const sanitized = sanitizeSensitiveText(raw, [SECRET]);

  assert.doesNotMatch(sanitized, /gemini|google|generativelanguage|canary-secret|x-goog/i);
  assert.match(sanitized, /high demand/i);
});

test("terminal error metadata and provider names in answer content are sanitized", () => {
  const thought = "The mathematical answer text says Gemini 3.6 verbatim.";
  const payload = {
    event_type: "interaction.completed",
    model: "gemini-3.6-flash",
    interaction: {
      status: "failed",
      provider: "Google",
      errors: [
        {
          code: "GEMINI_RESOURCE_EXHAUSTED",
          message: `Gemini 3.6 high demand; key=${SECRET}`
        }
      ],
      status_details: {
        provider_message: `Google Gemini ${SECRET}`
      },
      steps: [
        {
          type: "model_output",
          content: [{ type: "text", text: thought }]
        }
      ]
    }
  };

  assert.equal(sanitizePublicPayload(payload, [SECRET]), true);
  assert.equal(payload.model, undefined);
  assert.equal(payload.interaction.provider, undefined);
  assert.equal(
    payload.interaction.steps[0].content[0].text,
    "The mathematical answer text says AI service verbatim."
  );
  assert.doesNotMatch(JSON.stringify(payload.interaction.errors), /gemini|google|canary-secret/i);
  assert.doesNotMatch(JSON.stringify(payload.interaction.status_details), /gemini|google|canary-secret/i);
  assert.match(payload.interaction.errors[0].message, /high demand/i);
});

test("SSE comments are dropped and error events are sanitized", () => {
  const input =
    ": Gemini transport comment\n\n" +
    `data: ${JSON.stringify({
      event_type: "error",
      error: {
        code: "GEMINI_429",
        message: `Google model gemini-3.6-flash key ${SECRET} high demand`
      }
    })}\n\n`;
  const output = sanitizeSseText(input, [SECRET]);

  assert.doesNotMatch(output, /gemini|google|canary-secret/i);
  assert.match(output, /high demand/i);
  assert.match(output, /event_type/);
});

test("successful math is preserved while provider/model identifiers are neutralized", () => {
  const answer = "Korisnički sadržaj: Gemini 3.6; račun je \\(2+2=4\\).";
  const input =
    `data: ${JSON.stringify({
      event_type: "step.delta",
      model: "gemini-3.6-flash",
      delta: { type: "text", text: answer }
    })}\n\n`;
  const output = sanitizeSseText(input, [SECRET]);
  const payload = JSON.parse(output.match(/^data:\s*(.*)$/m)[1]);

  assert.equal(payload.model, undefined);
  assert.equal(
    payload.delta.text,
    "Korisnički sadržaj: AI service; račun je \\(2+2=4\\)."
  );
});

test("standalone Google in math content is preserved, but provider phrases are neutralized", () => {
  const input =
    `data: ${JSON.stringify({
      event_type: "step.delta",
      delta: {
        type: "text",
        text: "Google je pojam u zadatku; Google AI i Gemini 3.6 nisu javni nazivi."
      }
    })}\n\n`;
  const output = sanitizeSseText(input, []);
  const payload = JSON.parse(output.match(/^data:\s*(.*)$/m)[1]);

  assert.equal(
    payload.delta.text,
    "Google je pojam u zadatku; AI service i AI service nisu javni nazivi."
  );
});

test("unknown error fields cannot leak branding, model IDs, or secrets", () => {
  const payload = {
    event_type: "error",
    status: "GEMINI_FAILURE",
    debug: SECRET,
    service: "Google Gemini 3.6",
    nested: {
      endpoint: "https://generativelanguage.googleapis.com/v1beta/interactions",
      model_name: "gemini-3.6-flash"
    }
  };

  assert.equal(sanitizePublicPayload(payload, [SECRET]), true);
  assert.equal(payload.nested.model_name, undefined);
  assert.doesNotMatch(
    JSON.stringify(payload),
    /gemini|google|generativelanguage|canary-secret/i
  );
});

test("incremental SSE sanitizer handles one-byte chunks and split UTF-8", async () => {
  const input =
    `data: ${JSON.stringify({
      event_type: "error",
      error: {
        message: `Privremena greška: Gemini 3.6, ${SECRET}`
      }
    })}\r\n\r\n`;
  const bytes = new TextEncoder().encode(input);
  const source = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    }
  });
  let resets = 0;
  let cleanups = 0;
  const output = await streamToText(
    createSanitizedSseStream(source, [SECRET], {
      reset() {
        resets += 1;
      },
      cleanup() {
        cleanups += 1;
      },
      cancel() {}
    })
  );

  assert.doesNotMatch(output, /gemini|canary-secret/i);
  assert.match(output, /Privremena greška/);
  assert.equal(resets, bytes.byteLength);
  assert.equal(cleanups, 1);
});

test("malformed explicit SSE error becomes a neutral valid error event", () => {
  const output = sanitizeSseText(
    "event: error\ndata: not-json Gemini secret\n\n",
    [SECRET]
  );
  const data = output.match(/^data:\s*(.*)$/m)[1];
  const payload = JSON.parse(data);

  assert.equal(payload.event_type, "error");
  assert.equal(payload.error.code, "stream_error");
  assert.doesNotMatch(output, /gemini|secret/i);
});

test("malformed data without an event field also fails closed", () => {
  const output = sanitizeSseText(
    `data: truncated {"error":"Google Gemini ${SECRET}\n\n`,
    [SECRET]
  );
  const payload = JSON.parse(output.match(/^data:\s*(.*)$/m)[1]);

  assert.equal(payload.event_type, "error");
  assert.equal(payload.error.code, "stream_error");
  assert.doesNotMatch(output, /gemini|google|canary-secret/i);
});

test("unused SSE event, id, retry, and comment fields are never forwarded", () => {
  const output = sanitizeSseText(
    `: Google Gemini comment\n` +
      `event: Gemini-3.6\n` +
      `id: ${SECRET}\n` +
      `retry: 1000\n` +
      `data: ${JSON.stringify({ event_type: "step.delta", delta: { type: "text", text: "bezbedno" } })}\n\n`,
    [SECRET]
  );

  assert.doesNotMatch(output, /^(?:event|id|retry|:)/m);
  assert.doesNotMatch(output, /gemini|google|canary-secret/i);
  assert.match(output, /bezbedno/);
});

test("stream proxy applies backpressure instead of draining an unread source", async () => {
  let pulls = 0;
  const encoder = new TextEncoder();
  const source = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            event_type: "step.delta",
            delta: { type: "text", text: `deo ${pulls}` }
          })}\n\n`
        )
      );
    }
  });
  const lifecycle = {
    reason: "",
    reset() {},
    cleanup() {},
    cancel() {}
  };
  const proxy = createSanitizedSseStream(source, [], lifecycle);

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(pulls <= 3, `unread proxy pulled ${pulls} source chunks`);
  await proxy.cancel("test complete");
});

test("stream sanitizer cancels upstream when an event exceeds its buffer ceiling", async () => {
  let sourceCancelled = false;
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(`data: ${"A".repeat(512 * 1024 + 1)}\n\n`)
      );
    },
    cancel() {
      sourceCancelled = true;
    }
  });
  let lifecycleCancelled = false;
  const proxy = createSanitizedSseStream(source, [], {
    reason: "",
    reset() {},
    cleanup() {},
    cancel() {
      lifecycleCancelled = true;
    }
  });
  const output = await streamToText(proxy);

  assert.equal(sourceCancelled, true);
  assert.equal(lifecycleCancelled, true);
  assert.match(output, /"code":502/);
  assert.doesNotMatch(output, /A{100}/);
});
