const BRAND_METADATA_KEYS = new Set([
  "model",
  "modelid",
  "modelname",
  "modelversion",
  "provider",
  "providername",
  "upstream",
  "upstreamurl"
]);
const CONTENT_BRANCH_KEYS = new Set([
  "content",
  "delta",
  "parts",
  "step",
  "steps",
  "summary",
  "text"
]);
const ERROR_BRANCH_KEYS = new Set([
  "debug",
  "details",
  "error",
  "errors",
  "failurereason",
  "service",
  "statusdetails",
  "statusmessage"
]);
const MAX_SSE_EVENT_CHARS = 512 * 1024;

function normalizedKey(value) {
  return String(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function sanitizeSensitiveText(
  value,
  secrets = [],
  { replaceBareGoogle = true } = {}
) {
  let result = String(value ?? "");

  for (const secret of secrets) {
    if (typeof secret === "string" && secret) {
      result = result.split(secret).join("[redacted]");
    }
  }

  result = result
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, "[redacted]")
    .replace(/https?:\/\/generativelanguage\.googleapis\.com[^\s"']*/gi, "AI service")
    .replace(/generativelanguage\.googleapis\.com/gi, "AI service")
    .replace(/models?\/gemini[-._A-Za-z0-9]*/gi, "selected model")
    .replace(
      /gemini(?:[-_.\s]*(?:\d+(?:\.\d+)*|flash|pro|ultra|nano|agent|preview|latest))*/gi,
      "AI service"
    )
    .replace(/google\s+generative\s+language/gi, "AI service")
    .replace(/google\s+ai/gi, "AI service")
    .replace(/x-goog-api-key/gi, "API credential");

  return replaceBareGoogle
    ? result.replace(/\bgoogle\b/gi, "AI service")
    : result;
}

function sanitizePayloadValue(
  value,
  secrets,
  contentContext = false,
  forceStrict = false
) {
  if (typeof value === "string") {
    const sanitized = sanitizeSensitiveText(value, secrets, {
      replaceBareGoogle: forceStrict || !contentContext
    });
    return { value: sanitized, changed: sanitized !== value };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const result = value.map(item => {
      const nested = sanitizePayloadValue(
        item,
        secrets,
        contentContext,
        forceStrict
      );
      changed = nested.changed || changed;
      return nested.value;
    });
    return { value: result, changed };
  }

  if (value && typeof value === "object") {
    const result = {};
    let changed = false;
    const eventType = String(value.event_type || value.type || "").toLowerCase();
    const errorEvent = eventType === "error" || eventType.endsWith(".error");

    for (const [key, nested] of Object.entries(value)) {
      const keyName = normalizedKey(key);
      if (BRAND_METADATA_KEYS.has(keyName)) {
        changed = true;
        continue;
      }

      const strictBranch =
        forceStrict || errorEvent || ERROR_BRANCH_KEYS.has(keyName);
      const nestedContent = strictBranch
        ? false
        : contentContext || CONTENT_BRANCH_KEYS.has(keyName);
      const sanitized = sanitizePayloadValue(
        nested,
        secrets,
        nestedContent,
        strictBranch
      );
      result[key] = sanitized.value;
      changed = sanitized.changed || changed;
    }
    return { value: result, changed };
  }

  return { value, changed: false };
}

export function sanitizePublicPayload(payload, secrets = []) {
  if (!payload || typeof payload !== "object") return false;
  const sanitized = sanitizePayloadValue(payload, secrets);
  if (!sanitized.changed) return false;

  if (Array.isArray(payload)) {
    payload.splice(0, payload.length, ...sanitized.value);
  } else {
    for (const key of Object.keys(payload)) delete payload[key];
    Object.assign(payload, sanitized.value);
  }
  return true;
}

function sanitizeSseBlock(block, secrets) {
  if (!block) return "";

  const eol = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r\n|\n|\r/);
  const publicLines = lines.filter(
    line => !line || line.startsWith("data:")
  );
  const metadataRemoved = publicLines.length !== lines.length;
  const dataIndexes = [];
  const dataValues = [];

  for (let index = 0; index < publicLines.length; index++) {
    const line = publicLines[index];
    if (!line.startsWith("data:")) continue;
    dataIndexes.push(index);
    const raw = line.slice(5);
    dataValues.push(raw.startsWith(" ") ? raw.slice(1) : raw);
  }

  if (!dataIndexes.length) {
    return "";
  }

  const joinedData = dataValues.join("\n");
  if (joinedData.trim() === "[DONE]") {
    return metadataRemoved ? publicLines.join(eol) : block;
  }

  let payload;
  let forceRebuild = false;
  try {
    payload = JSON.parse(joinedData);
  } catch {
    payload = {
      event_type: "error",
      error: {
        code: "stream_error",
        message: "The streamed request ended with an error."
      }
    };
    forceRebuild = true;
  }

  if (!payload || typeof payload !== "object") {
    payload = {
      event_type: "error",
      error: {
        code: "stream_error",
        message: "The streamed request returned an invalid event."
      }
    };
    forceRebuild = true;
  }

  const changed = sanitizePublicPayload(payload, secrets);
  if (!forceRebuild && !changed && !metadataRemoved) return block;

  const firstDataIndex = dataIndexes[0];
  const rebuilt = publicLines.filter(
    (_line, index) => !dataIndexes.includes(index) || index === firstDataIndex
  );
  rebuilt[firstDataIndex] = `data: ${JSON.stringify(payload)}`;
  return rebuilt.join(eol);
}

class SseSanitizer {
  constructor(secrets) {
    this.secrets = secrets;
    this.buffer = "";
  }

  push(text, final = false) {
    this.buffer += text;
    let output = "";

    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;

      const block = this.buffer.slice(0, match.index);
      if (block.length > MAX_SSE_EVENT_CHARS) {
        throw new Error("SSE event exceeded the safe buffer limit.");
      }
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const sanitized = sanitizeSseBlock(block, this.secrets);
      if (sanitized) output += sanitized + match[0];
    }

    if (this.buffer.length > MAX_SSE_EVENT_CHARS) {
      throw new Error("SSE event exceeded the safe buffer limit.");
    }

    if (final && this.buffer) {
      output += sanitizeSseBlock(this.buffer, this.secrets);
      this.buffer = "";
    }

    return output;
  }
}

export function sanitizeSseText(value, secrets = []) {
  const sanitizer = new SseSanitizer(secrets);
  return sanitizer.push(String(value), true);
}

export function createSanitizedSseStream(source, secrets, lifecycle) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const sanitizer = new SseSanitizer(secrets);
  const reader = source.getReader();
  let cancelled = false;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    lifecycle.cleanup();
    try {
      reader.releaseLock();
    } catch {}
  };

  const enqueueStreamError = controller => {
    const timedOut = lifecycle.reason === "timeout";
    const event = {
      event_type: "error",
      error: {
        code: timedOut ? 504 : 502,
        status: timedOut ? "DEADLINE_EXCEEDED" : "UNAVAILABLE",
        message: timedOut
          ? "The AI service is temporarily unavailable because the request timed out."
          : "The AI service connection was interrupted."
      }
    };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    controller.close();
  };

  return new ReadableStream({
    async pull(controller) {
      if (finished || cancelled) return;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            const output = sanitizer.push(decoder.decode(), true);
            if (output) controller.enqueue(encoder.encode(output));
            controller.close();
            finish();
            return;
          }

          lifecycle.reset();
          const output = sanitizer.push(
            decoder.decode(value, { stream: true })
          );
          if (output) {
            controller.enqueue(encoder.encode(output));
            return;
          }
        }
      } catch {
        if (!cancelled && lifecycle.reason !== "client") {
          enqueueStreamError(controller);
        } else if (!cancelled) {
          controller.close();
        }
        lifecycle.cancel(
          new DOMException("Streaming transformation stopped", "AbortError")
        );
        try {
          await reader.cancel("streaming transformation stopped");
        } catch {}
        finish();
      }
    },

    async cancel(reason) {
      cancelled = true;
      lifecycle.cancel(reason);
      try {
        await reader.cancel(reason);
      } catch {}
      finish();
    }
  });
}
