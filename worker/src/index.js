import {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  GATEWAY_MARKER_HEADER,
  GATEWAY_MARKER_VALUE,
  HEALTH_PATH,
  MAX_SYNC_RESPONSE_BYTES,
  MAX_UPSTREAM_ERROR_BYTES,
  PUBLIC_PATH,
  UPSTREAM_INTERACTIONS_URL,
  buildUpstreamBody
} from "./config.js";
import {
  ContractError,
  isJsonContentType,
  readJsonBody,
  validatePublicBody
} from "./contract.js";
import { RateCoordinator } from "./limiter.js";
import {
  createSanitizedSseStream,
  sanitizePublicPayload
} from "./sanitize.js";

export { RateCoordinator };

const SAFE_REQUEST_HEADERS = new Set(["content-type", "x-math-api-slot"]);
const FORBIDDEN_CLIENT_HEADERS = [
  "authorization",
  "x-api-key",
  "x-goog-api-key"
];

function baseHeaders() {
  return new Headers({
    "Cache-Control": "no-store",
    [GATEWAY_MARKER_HEADER]: GATEWAY_MARKER_VALUE,
    "X-Content-Type-Options": "nosniff"
  });
}

function addCors(headers, origin) {
  if (!origin) return headers;
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set(
    "Access-Control-Expose-Headers",
    `Retry-After, ${GATEWAY_MARKER_HEADER}`
  );
  headers.append("Vary", "Origin");
  return headers;
}

function jsonResponse(status, code, message, origin, extraHeaders = {}) {
  const headers = addCors(baseHeaders(), origin);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }

  return new Response(
    JSON.stringify({ error: { code, message, status } }),
    { status, headers }
  );
}

function parseAllowedOrigins(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map(origin => origin.trim())
      .filter(origin => {
        if (!origin || origin === "*" || origin === "null") return false;
        try {
          const url = new URL(origin);
          return url.protocol === "https:" && url.origin === origin;
        } catch {
          return false;
        }
      })
  );
}

function allowedRequestOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return "";
  return parseAllowedOrigins(env.ALLOWED_ORIGINS).has(origin) ? origin : "";
}

function preflightResponse(request, env) {
  const origin = allowedRequestOrigin(request, env);
  if (!origin) {
    return jsonResponse(403, "origin_not_allowed", "This origin is not allowed.", "");
  }

  if (request.headers.get("Access-Control-Request-Method") !== "POST") {
    return jsonResponse(403, "preflight_not_allowed", "This preflight request is not allowed.", origin);
  }

  const requestedHeaders = String(
    request.headers.get("Access-Control-Request-Headers") || ""
  )
    .split(",")
    .map(header => header.trim().toLowerCase())
    .filter(Boolean);

  if (requestedHeaders.some(header => !SAFE_REQUEST_HEADERS.has(header))) {
    return jsonResponse(403, "preflight_not_allowed", "This preflight request is not allowed.", origin);
  }

  const headers = addCors(baseHeaders(), origin);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Math-Api-Slot");
  headers.set("Access-Control-Max-Age", "600");
  return new Response(null, { status: 204, headers });
}

function readSlot(request) {
  const slot = request.headers.get("X-Math-Api-Slot") || "";
  return /^[1-4]$/.test(slot) ? slot : "";
}

async function reserveSlot(env, slot) {
  if (!env.RATE_COORDINATOR) {
    throw new Error("Rate coordinator binding is unavailable.");
  }

  const id = env.RATE_COORDINATOR.idFromName("global");
  const stub = env.RATE_COORDINATOR.get(id);
  const response = await stub.fetch("https://rate-coordinator.internal/reserve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slot })
  });

  if (!response.ok) {
    throw new Error("Rate coordinator rejected the reservation.");
  }

  const result = await response.json();
  if (
    typeof result?.allowed !== "boolean" ||
    !Number.isFinite(result?.retryAfterMs) ||
    result.retryAfterMs < 0
  ) {
    throw new Error("Rate coordinator returned an invalid reservation.");
  }

  return result;
}

function configuredTimeout(env, options) {
  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    return options.timeoutMs;
  }

  const configured = Number(env.UPSTREAM_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured >= 10_000 && configured <= 300_000) {
    return configured;
  }
  return DEFAULT_UPSTREAM_TIMEOUT_MS;
}

function createAbortLifecycle(clientSignal, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  let reason = "";

  const abort = (kind, detail) => {
    if (controller.signal.aborted) return;
    reason = kind;
    controller.abort(detail);
  };

  const reset = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      abort("timeout", new DOMException("Upstream timeout", "TimeoutError"));
    }, timeoutMs);
  };

  const onClientAbort = () => {
    abort("client", clientSignal.reason || new DOMException("Client aborted", "AbortError"));
  };

  if (clientSignal?.aborted) {
    onClientAbort();
  } else {
    clientSignal?.addEventListener("abort", onClientAbort, { once: true });
  }
  reset();

  return {
    signal: controller.signal,
    get reason() {
      return reason;
    },
    reset,
    cancel(detail) {
      abort("client", detail || new DOMException("Client cancelled", "AbortError"));
    },
    cleanup() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      clientSignal?.removeEventListener("abort", onClientAbort);
    }
  };
}

async function readLimitedBody(body, maximumBytes, lifecycle) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lifecycle.reset();
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("response too large");
        throw new Error("Response exceeded the safe size limit.");
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function publicUpstreamError(status, rawText, origin) {
  const raw = String(rawText || "").toLowerCase();

  if (
    /previous[_ -]?interaction/.test(raw) &&
    /not found|expired|missing|requested entity/.test(raw)
  ) {
    return jsonResponse(
      404,
      "previous_interaction_not_found",
      "The previous interaction was not found or has expired.",
      origin
    );
  }

  if (
    /image input modality|unsupported.{0,100}model|model.{0,100}(?:not enabled|not supported|unsupported|not available|not found)|unimplemented/.test(raw)
  ) {
    return jsonResponse(
      422,
      "unsupported_capability",
      "Image input modality is not enabled for the selected model.",
      origin
    );
  }

  if (
    /(?:api.?key|key).{0,40}(?:not valid|invalid|rejected|expired)|unauthenticated/.test(raw)
  ) {
    return jsonResponse(401, "authentication_failed", "The selected API slot could not be authorized.", origin);
  }

  if (/quota.{0,40}(?:exceeded|exhausted|limit)|resource.?exhausted/.test(raw)) {
    return jsonResponse(429, "upstream_rate_limited", "The AI service is temporarily rate limited. Try again later.", origin);
  }

  if (
    /(?:service.{0,50})?experiencing high demand|(?:service|server).{0,50}(?:temporar(?:y|ily) unavailable|overloaded)|please try again later|"(?:status|code)"\s*:\s*"unavailable"/.test(raw)
  ) {
    return jsonResponse(503, "upstream_unavailable", "The AI service is temporarily unavailable due to high demand.", origin);
  }

  if (
    status === 400 &&
    /permission.{0,30}(?:denied|not granted|invalid)|project.{0,50}(?:not authorized|not permitted|disabled)/.test(raw)
  ) {
    return jsonResponse(403, "permission_denied", "The selected API slot does not have permission for this request.", origin);
  }

  if (status === 401) {
    return jsonResponse(401, "authentication_failed", "The selected API slot could not be authorized.", origin);
  }
  if (status === 403) {
    return jsonResponse(403, "permission_denied", "The selected API slot does not have permission for this request.", origin);
  }
  if (status === 408) {
    return jsonResponse(504, "upstream_timeout", "The AI service did not respond in time.", origin);
  }
  if (status === 429) {
    return jsonResponse(429, "upstream_rate_limited", "The AI service is temporarily rate limited. Try again later.", origin);
  }
  if (status >= 500 && status <= 599) {
    return jsonResponse(status, "upstream_unavailable", "The AI service is temporarily unavailable.", origin);
  }
  if (status >= 400 && status <= 499) {
    return jsonResponse(status, "upstream_request_rejected", "The AI service rejected the request.", origin);
  }

  return jsonResponse(502, "upstream_error", "The AI service returned an invalid response.", origin);
}

function secretValues(env) {
  return [1, 2, 3, 4]
    .map(slot => env[`GEMINI_API_KEY_${slot}`])
    .filter(value => typeof value === "string" && value);
}

function responseHeaders(origin, contentType) {
  const headers = addCors(baseHeaders(), origin);
  headers.set("Content-Type", contentType);
  return headers;
}

async function proxyUpstream(request, env, origin, slot, publicBody, options) {
  const secret = env[`GEMINI_API_KEY_${slot}`];
  if (typeof secret !== "string" || !secret) {
    return jsonResponse(503, "slot_unavailable", "The selected API slot is not configured.", origin);
  }

  let reservation;
  try {
    reservation = await reserveSlot(env, slot);
  } catch {
    return jsonResponse(503, "rate_control_unavailable", "Request rate control is temporarily unavailable.", origin);
  }

  if (!reservation.allowed) {
    const retryAfter = String(
      Math.max(1, Math.ceil(reservation.retryAfterMs / 1000))
    );
    return jsonResponse(
      429,
      "slot_rate_limited",
      "This API slot has reached its rolling request limit. Try again later.",
      origin,
      { "Retry-After": retryAfter }
    );
  }

  const upstreamBody = buildUpstreamBody(publicBody);
  const upstreamUrl = publicBody.stream
    ? `${UPSTREAM_INTERACTIONS_URL}?alt=sse`
    : UPSTREAM_INTERACTIONS_URL;
  const lifecycle = createAbortLifecycle(
    request.signal,
    configuredTimeout(env, options)
  );

  let upstream;
  try {
    const fetchImpl = options.fetchImpl;
    upstream = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: publicBody.stream ? "text/event-stream" : "application/json",
        "x-goog-api-key": secret
      },
      body: JSON.stringify(upstreamBody),
      // Keep credentials on the fixed host. `manual` returns any 3xx to this
      // Worker, where it is rejected as a sanitized upstream error below.
      redirect: "manual",
      signal: lifecycle.signal
    });
    lifecycle.reset();
  } catch {
    const reason = lifecycle.reason;
    lifecycle.cleanup();
    if (reason === "client") {
      return jsonResponse(499, "client_closed_request", "The request was cancelled.", origin);
    }
    if (reason === "timeout") {
      return jsonResponse(504, "upstream_timeout", "The AI service did not respond in time.", origin);
    }
    return jsonResponse(502, "upstream_connection_failed", "The AI service could not be reached.", origin);
  }

  if (upstream.status >= 300 && upstream.status <= 399) {
    try {
      await upstream.body?.cancel("redirect rejected");
    } catch {}
    lifecycle.cleanup();
    return jsonResponse(
      502,
      "upstream_redirect_rejected",
      "The AI service returned an invalid redirect.",
      origin
    );
  }

  if (!upstream.ok) {
    let rawText = "";
    try {
      const bytes = await readLimitedBody(
        upstream.body,
        MAX_UPSTREAM_ERROR_BYTES,
        lifecycle
      );
      rawText = new TextDecoder().decode(bytes);
    } catch {}
    const reason = lifecycle.reason;
    lifecycle.cleanup();
    if (reason === "client") {
      return jsonResponse(499, "client_closed_request", "The request was cancelled.", origin);
    }
    if (reason === "timeout") {
      return jsonResponse(504, "upstream_timeout", "The AI service did not respond in time.", origin);
    }
    return publicUpstreamError(upstream.status, rawText, origin);
  }

  if (publicBody.stream) {
    const contentType = upstream.headers.get("Content-Type") || "";
    if (!upstream.body || !/^text\/event-stream(?:\s*;|$)/i.test(contentType)) {
      lifecycle.cancel(new DOMException("Invalid streaming response", "AbortError"));
      lifecycle.cleanup();
      return jsonResponse(502, "invalid_upstream_response", "The AI service returned an invalid streaming response.", origin);
    }

    const body = createSanitizedSseStream(
      upstream.body,
      secretValues(env),
      lifecycle
    );
    return new Response(body, {
      status: upstream.status,
      headers: responseHeaders(origin, "text/event-stream; charset=utf-8")
    });
  }

  let bytes;
  try {
    bytes = await readLimitedBody(
      upstream.body,
      MAX_SYNC_RESPONSE_BYTES,
      lifecycle
    );
  } catch {
    const reason = lifecycle.reason;
    lifecycle.cleanup();
    if (reason === "client") {
      return jsonResponse(499, "client_closed_request", "The request was cancelled.", origin);
    }
    if (reason === "timeout") {
      return jsonResponse(504, "upstream_timeout", "The AI service did not respond in time.", origin);
    }
    return jsonResponse(502, "invalid_upstream_response", "The AI service returned an invalid response.", origin);
  }
  lifecycle.cleanup();

  let text;
  let payload;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    payload = JSON.parse(text);
  } catch {
    return jsonResponse(502, "invalid_upstream_response", "The AI service returned an invalid JSON response.", origin);
  }

  if (sanitizePublicPayload(payload, secretValues(env))) {
    text = JSON.stringify(payload);
  }

  return new Response(text, {
    status: upstream.status,
    headers: responseHeaders(origin, "application/json; charset=utf-8")
  });
}

export async function handleRequest(request, env, ctx, options = {}) {
  const url = new URL(request.url);
  const providedFetchImpl = options.fetchImpl;
  const fetchImpl = providedFetchImpl
    ? (...args) => providedFetchImpl(...args)
    : (...args) => globalThis.fetch(...args);
  const runtimeOptions = { ...options, fetchImpl };

  if (url.pathname === HEALTH_PATH && request.method === "GET") {
    const headers = addCors(
      baseHeaders(),
      allowedRequestOrigin(request, env)
    );
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  const possibleOrigin = allowedRequestOrigin(request, env);

  if (url.pathname !== PUBLIC_PATH) {
    return jsonResponse(404, "not_found", "The requested route does not exist.", possibleOrigin);
  }

  if (request.method === "OPTIONS") {
    return preflightResponse(request, env);
  }

  if (request.method !== "POST") {
    return jsonResponse(
      405,
      "method_not_allowed",
      "Only POST and OPTIONS are allowed for this route.",
      possibleOrigin,
      { Allow: "POST, OPTIONS" }
    );
  }

  if (!possibleOrigin) {
    return jsonResponse(403, "origin_not_allowed", "This origin is not allowed.", "");
  }

  if (!isJsonContentType(request.headers.get("Content-Type"))) {
    return jsonResponse(415, "unsupported_media_type", "Content-Type must be application/json.", possibleOrigin);
  }

  const slot = readSlot(request);
  if (!slot) {
    return jsonResponse(400, "invalid_slot", "X-Math-Api-Slot must be a number from 1 to 4.", possibleOrigin);
  }

  if (FORBIDDEN_CLIENT_HEADERS.some(header => request.headers.has(header))) {
    return jsonResponse(400, "forbidden_header", "The request contains a forbidden credential header.", possibleOrigin);
  }

  let publicBody;
  try {
    publicBody = validatePublicBody(await readJsonBody(request));
  } catch (error) {
    if (error instanceof ContractError) {
      return jsonResponse(
        error.status,
        error.code,
        error.message,
        possibleOrigin
      );
    }
    return jsonResponse(400, "invalid_request", "The request could not be read.", possibleOrigin);
  }

  return proxyUpstream(
    request,
    env,
    possibleOrigin,
    slot,
    publicBody,
    runtimeOptions
  );
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};
