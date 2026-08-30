import {
  MAX_IMAGE_BYTES,
  MAX_PREVIOUS_INTERACTION_ID_BYTES,
  MAX_REQUEST_BYTES,
  MAX_TEXT_BYTES
} from "./config.js";

const encoder = new TextEncoder();
const TOP_LEVEL_FIELDS = new Set([
  "input",
  "stream",
  "previous_interaction_id",
  "generation_settings"
]);
const GENERATION_SETTINGS_FIELDS = new Set([
  "thinking_level",
  "code_execution"
]);
const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high"]);
const TEXT_FIELDS = new Set(["type", "text"]);
const IMAGE_FIELDS = new Set([
  "type",
  "data",
  "mime_type",
  "resolution"
]);

export class ContractError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ContractError";
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new ContractError(status, code, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactFields(value, allowed, label) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      fail(400, "invalid_request", `${label} contains an unsupported field.`);
    }
  }
}

function utf8Length(value) {
  return encoder.encode(value).byteLength;
}

function validateTextPart(part) {
  if (!isRecord(part)) {
    fail(400, "invalid_input", "Each input item must be an object.");
  }

  assertExactFields(part, TEXT_FIELDS, "The text input item");

  if (part.type !== "text" || typeof part.text !== "string") {
    fail(400, "invalid_input", "The request must contain one text input item.");
  }

  if (!part.text.trim()) {
    fail(400, "invalid_input", "The text input must not be empty.");
  }

  if (utf8Length(part.text) > MAX_TEXT_BYTES) {
    fail(413, "text_too_large", "The text input is too large.");
  }
}

function validateGenerationSettings(settings) {
  if (!isRecord(settings)) {
    fail(400, "invalid_generation_settings", "The generation settings must be an object.");
  }

  assertExactFields(
    settings,
    GENERATION_SETTINGS_FIELDS,
    "The generation settings"
  );

  if (
    Object.hasOwn(settings, "thinking_level") &&
    !THINKING_LEVELS.has(settings.thinking_level)
  ) {
    fail(
      400,
      "invalid_generation_settings",
      "The thinking level must be minimal, low, medium, or high."
    );
  }

  if (
    Object.hasOwn(settings, "code_execution") &&
    typeof settings.code_execution !== "boolean"
  ) {
    fail(
      400,
      "invalid_generation_settings",
      "The code execution setting must be a boolean."
    );
  }
}

function decodedBase64Size(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function isCanonicalBase64(value) {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function validateImagePart(part) {
  if (!isRecord(part)) {
    fail(400, "invalid_input", "Each input item must be an object.");
  }

  assertExactFields(part, IMAGE_FIELDS, "The image input item");

  if (
    part.type !== "image" ||
    typeof part.data !== "string" ||
    part.mime_type !== "image/jpeg" ||
    part.resolution !== "high"
  ) {
    fail(400, "invalid_image", "Only one high-resolution JPEG image is supported.");
  }

  if (
    !part.data ||
    part.data.length % 4 !== 0
  ) {
    fail(400, "invalid_image", "The JPEG image data is not valid base64.");
  }

  if (decodedBase64Size(part.data) > MAX_IMAGE_BYTES) {
    fail(413, "image_too_large", "The JPEG image is too large.");
  }

  if (!isCanonicalBase64(part.data)) {
    fail(400, "invalid_image", "The JPEG image data is not valid base64.");
  }

  if (!part.data.startsWith("/9j/")) {
    fail(400, "invalid_image", "The image data does not contain a JPEG image.");
  }
}

export function validatePublicBody(value) {
  if (!isRecord(value)) {
    fail(400, "invalid_request", "The JSON body must be an object.");
  }

  assertExactFields(value, TOP_LEVEL_FIELDS, "The request body");

  if (!Object.hasOwn(value, "input") || !Array.isArray(value.input)) {
    fail(400, "invalid_input", "The request must contain an input array.");
  }

  if (!Object.hasOwn(value, "stream") || typeof value.stream !== "boolean") {
    fail(400, "invalid_request", "The stream field must be a boolean.");
  }

  if (Object.hasOwn(value, "generation_settings")) {
    validateGenerationSettings(value.generation_settings);
  }

  if (value.input.length < 1 || value.input.length > 2) {
    fail(400, "invalid_input", "The input must contain one text item and at most one image.");
  }

  const textItems = value.input.filter(item => item?.type === "text");
  const imageItems = value.input.filter(item => item?.type === "image");

  if (textItems.length !== 1 || imageItems.length > 1) {
    fail(400, "invalid_input", "The input must contain one text item and at most one image.");
  }

  for (const item of value.input) {
    if (item?.type !== "text" && item?.type !== "image") {
      fail(400, "invalid_input", "The input contains an unsupported item type.");
    }
  }

  if (imageItems.length === 1) {
    if (value.input[0] !== imageItems[0] || value.input[1] !== textItems[0]) {
      fail(400, "invalid_input", "The JPEG image must precede the text input item.");
    }
    validateImagePart(imageItems[0]);
  }

  validateTextPart(textItems[0]);

  if (Object.hasOwn(value, "previous_interaction_id")) {
    const id = value.previous_interaction_id;
    if (
      typeof id !== "string" ||
      !id ||
      id !== id.trim() ||
      /[\u0000-\u001f\u007f]/.test(id) ||
      utf8Length(id) > MAX_PREVIOUS_INTERACTION_ID_BYTES
    ) {
      fail(400, "invalid_previous_interaction", "The previous interaction identifier is invalid.");
    }
  }

  return value;
}

export function isJsonContentType(value) {
  return /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
    String(value || "")
  );
}

export async function readJsonBody(request) {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      fail(400, "invalid_request", "The Content-Length header is invalid.");
    }
    if (Number(declaredLength) > MAX_REQUEST_BYTES) {
      fail(413, "request_too_large", "The request body is too large.");
    }
  }

  if (!request.body) {
    fail(400, "invalid_json", "A JSON request body is required.");
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel("request too large");
        fail(413, "request_too_large", "The request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(400, "invalid_json", "The request body must be valid UTF-8 JSON.");
  }

  try {
    return JSON.parse(text);
  } catch {
    fail(400, "invalid_json", "The request body is not valid JSON.");
  }
}
