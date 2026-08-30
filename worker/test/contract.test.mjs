import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_IMAGE_BYTES,
  MAX_REQUEST_BYTES,
  MAX_TEXT_BYTES,
  SYSTEM_INSTRUCTION,
  UPSTREAM_MODEL,
  buildUpstreamBody
} from "../src/config.js";
import {
  ContractError,
  isJsonContentType,
  readJsonBody,
  validatePublicBody
} from "../src/contract.js";
import { validPublicBody } from "./helpers.mjs";

test("valid public body is preserved and fixed upstream policy is injected", () => {
  const input = [
    {
      type: "image",
      data: "/9j/2Q==",
      mime_type: "image/jpeg",
      resolution: "high"
    },
    { type: "text", text: "Izračunaj \(2+2\)." }
  ];
  const publicBody = validatePublicBody({
    input,
    stream: true,
    previous_interaction_id: "interaction_123"
  });
  const upstream = buildUpstreamBody(publicBody);

  assert.equal(upstream.model, UPSTREAM_MODEL);
  assert.equal(upstream.model, "gemini-3.6-flash");
  assert.strictEqual(upstream.input, input);
  assert.equal(upstream.stream, true);
  assert.equal(upstream.store, true);
  assert.equal(upstream.system_instruction, SYSTEM_INSTRUCTION);
  assert.equal(SYSTEM_INSTRUCTION.length, 1549);
  assert.deepEqual(upstream.tools, [{ type: "code_execution" }]);
  assert.deepEqual(upstream.generation_config, {
    thinking_level: "high",
    thinking_summaries: "auto"
  });
  assert.equal(upstream.previous_interaction_id, "interaction_123");
});

test("old and partial clients keep high thinking and code execution defaults", () => {
  for (const generation_settings of [undefined, {}, { thinking_level: "high" }, { code_execution: true }]) {
    const candidate = validPublicBody();
    if (generation_settings !== undefined) {
      candidate.generation_settings = generation_settings;
    }

    const publicBody = validatePublicBody(candidate);
    const upstream = buildUpstreamBody(publicBody);

    assert.deepEqual(upstream.generation_config, {
      thinking_level: "high",
      thinking_summaries: "auto"
    });
    assert.deepEqual(upstream.tools, [{ type: "code_execution" }]);
  }
});

test("generation settings allow each exact thinking level and a strict code-execution switch", () => {
  for (const thinking_level of ["minimal", "low", "medium", "high"]) {
    const publicBody = validatePublicBody({
      ...validPublicBody(),
      generation_settings: { thinking_level, code_execution: true }
    });
    const upstream = buildUpstreamBody(publicBody);

    assert.deepEqual(upstream.generation_config, {
      thinking_level,
      thinking_summaries: "auto"
    });
    assert.deepEqual(upstream.tools, [{ type: "code_execution" }]);
    assert.equal(upstream.generation_settings, undefined);
  }

  const withoutCodeExecution = buildUpstreamBody(
    validatePublicBody({
      ...validPublicBody(),
      generation_settings: { code_execution: false }
    })
  );
  assert.deepEqual(withoutCodeExecution.generation_config, {
    thinking_level: "high",
    thinking_summaries: "auto"
  });
  assert.equal(Object.hasOwn(withoutCodeExecution, "tools"), false);
});

test("generation settings reject wrong shapes, values, types, and nested policy injection", () => {
  const invalidSettings = [
    null,
    [],
    "high",
    true,
    { thinking_level: "" },
    { thinking_level: "HIGH" },
    { thinking_level: "none" },
    { thinking_level: 1 },
    { thinking_level: null },
    { code_execution: "true" },
    { code_execution: 1 },
    { code_execution: null },
    { tools: [{ type: "code_execution" }] },
    { generation_config: { thinking_level: "minimal" } },
    { grounding: true },
    { grounding_with_google_search: true },
    { model: "attacker-model" },
    { thinking_level: "low", extra: true }
  ];

  for (const generation_settings of invalidSettings) {
    assert.throws(
      () => validatePublicBody({ ...validPublicBody(), generation_settings }),
      error => error instanceof ContractError && error.status === 400,
      JSON.stringify(generation_settings)
    );
  }
});

test("browser cannot supply model, key, endpoint, system, tools, generation config, or grounding", () => {
  for (const field of [
    "model",
    "api_key",
    "url",
    "endpoint",
    "store",
    "system_instruction",
    "tools",
    "generation_config",
    "grounding",
    "grounding_with_google_search",
    "google_search",
    "thinking_level",
    "code_execution"
  ]) {
    assert.throws(
      () => validatePublicBody({ ...validPublicBody(), [field]: "attacker" }),
      error => error instanceof ContractError && error.status === 400,
      field
    );
  }
});

test("contract requires exactly one text item and at most one JPEG", () => {
  const image = {
    type: "image",
    data: "/9j/2Q==",
    mime_type: "image/jpeg",
    resolution: "high"
  };

  for (const input of [
    [],
    [image],
    [{ type: "text", text: "a" }, { type: "text", text: "b" }],
    [{ type: "text", text: "a" }, image],
    [{ type: "audio", data: "x" }, { type: "text", text: "a" }]
  ]) {
    assert.throws(
      () => validatePublicBody({ input, stream: true }),
      ContractError
    );
  }

  assert.throws(
    () =>
      validatePublicBody({
        input: [
          { ...image, mime_type: "image/png" },
          { type: "text", text: "a" }
        ],
        stream: true
      }),
    error => error.code === "invalid_image"
  );

  for (const resolution of [undefined, null, "low", "medium", "highest"]) {
    assert.throws(
      () =>
        validatePublicBody({
          input: [
            { ...image, resolution },
            { type: "text", text: "a" }
          ],
          stream: true
        }),
      error => error.code === "invalid_image",
      String(resolution)
    );
  }
});

test("text and decoded image limits are enforced", () => {
  assert.throws(
    () =>
      validatePublicBody({
        input: [{ type: "text", text: "č".repeat(MAX_TEXT_BYTES / 2 + 1) }],
        stream: false
      }),
    error => error.status === 413 && error.code === "text_too_large"
  );

  const blocks = Math.floor(MAX_IMAGE_BYTES / 3) + 1;
  const oversizedBase64 = "/9j/" + "AAAA".repeat(blocks);
  assert.throws(
    () =>
      validatePublicBody({
        input: [
          {
            type: "image",
            data: oversizedBase64,
            mime_type: "image/jpeg",
            resolution: "high"
          },
          { type: "text", text: "a" }
        ],
        stream: false
      }),
    error => error.status === 413 && error.code === "image_too_large"
  );
});

test("previous interaction identifier and stream flag are strict", () => {
  for (const previous_interaction_id of ["", " padded", "line\nbreak", 42]) {
    assert.throws(
      () => validatePublicBody({ ...validPublicBody(), previous_interaction_id }),
      ContractError
    );
  }

  assert.throws(
    () => validatePublicBody({ input: validPublicBody().input, stream: "true" }),
    ContractError
  );
});

test("JSON Content-Type allows only application/json with optional UTF-8 charset", () => {
  assert.equal(isJsonContentType("application/json"), true);
  assert.equal(isJsonContentType("application/json; charset=UTF-8"), true);
  assert.equal(isJsonContentType("application/json; charset=iso-8859-1"), false);
  assert.equal(isJsonContentType("text/json"), false);
  assert.equal(isJsonContentType("application/json-patch+json"), false);
});

test("bounded reader rejects oversized declared bodies before reading", async () => {
  const request = new Request("https://worker.example/v1/interactions", {
    method: "POST",
    headers: { "Content-Length": String(MAX_REQUEST_BYTES + 1) },
    body: "{}"
  });

  await assert.rejects(
    () => readJsonBody(request),
    error => error.status === 413 && error.code === "request_too_large"
  );
});

test("bounded reader stops a chunked body as soon as the actual limit is crossed", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let chunksSent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (chunksSent < 8) {
        chunksSent += 1;
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    }
  });
  const request = new Request("https://worker.example/v1/interactions", {
    method: "POST",
    body,
    duplex: "half"
  });

  await assert.rejects(
    () => readJsonBody(request),
    error => error.status === 413 && error.code === "request_too_large"
  );
  assert.equal(
    chunksSent,
    Math.floor(MAX_REQUEST_BYTES / chunk.byteLength) + 1
  );
});

test("bounded reader rejects invalid JSON, scalar JSON, and invalid UTF-8", async () => {
  const invalidJson = new Request("https://worker.example", {
    method: "POST",
    body: "{"
  });
  await assert.rejects(() => readJsonBody(invalidJson), ContractError);

  assert.throws(() => validatePublicBody(null), ContractError);
  assert.throws(() => validatePublicBody([]), ContractError);
  assert.throws(() => validatePublicBody("value"), ContractError);

  const invalidUtf8 = new Request("https://worker.example", {
    method: "POST",
    body: new Uint8Array([0xc3, 0x28])
  });
  await assert.rejects(
    () => readJsonBody(invalidUtf8),
    error => error.code === "invalid_json"
  );
});
