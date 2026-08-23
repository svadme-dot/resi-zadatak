import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..', '..');
const DOCS_DIR = path.join(WORKSPACE, 'docs');
const FIXTURES_DIR = path.join(HERE, 'fixtures');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const MODEL = 'gemini-3.6-flash';
const IMAGE_MODALITY_MESSAGE =
  'Image input modality is not enabled for models/gemini-3.6-flash-agent';
const UNSUPPORTED_IMAGE_PAYLOAD_MESSAGE =
  'Unsupported image format/MIME';
const HIGH_DEMAND_MESSAGE =
  'gemini-3.6-flash is currently experiencing high demand, spikes in demand are usually temporary. Please try again later.';
const EXPECTED_FOUR_PROFILE_ORDER = [
  ['e2e-api-1', MODEL],
  ['e2e-api-2', MODEL],
  ['e2e-api-3', MODEL],
  ['e2e-api-4', MODEL]
];
const EXPECTED_THOUGHT_HIGH_DEMAND_ORDER =
  EXPECTED_FOUR_PROFILE_ORDER.map(tuple => [...tuple]);
const LOCAL_API_KEYS = [1, 2, 3, 4].map(
  slot => 'e2e-local-api-' + slot
);
const LOCAL_FALLBACK_SCENARIOS = new Set([
  'gateway-success-local-unused',
  'gateway-marked-upstream-no-local',
  'gateway-sse-transport-error-no-fallback',
  'gateway-rate-control-local',
  'gateway-unmarked-deployment-local',
  'gateway-fetch-health-fail-local',
  'local-key-fallback-order'
]);
const VALID_SCENARIOS = new Set([
  'success',
  'slow',
  'fallback-429',
  'fallback-four',
  'partial-no-continue',
  'sse-error-next-profile',
  'terminal-failed-next-profile',
  'thought-high-demand-four',
  'answer-high-demand-no-fallback',
  'payload-error-no-fallback',
  'retry-after-reload',
  ...LOCAL_FALLBACK_SCENARIOS,
  'gateway-down-no-local-keys'
]);
const RETRY_PROMPT =
  'E2E ponovni pokušaj: reši jednačinu 2x + 3 = 11.';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8']
]);

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 12 * 1024 * 1024) {
      const error = new Error('Request body exceeds the 12 MiB harness limit.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Request body is not valid JSON.');
    error.status = 400;
    throw error;
  }
}

function scenarioFrom(url) {
  const requested = url.searchParams.get('scenario') || 'success';
  return VALID_SCENARIOS.has(requested) ? requested : 'success';
}

function findImagePart(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  return input.find(part => part?.type === 'image') || null;
}

function findTextPart(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  const textParts = input.filter(part => part?.type === 'text');
  return textParts.length ? String(textParts[textParts.length - 1]?.text || '') : '';
}

function isBase64(value) {
  if (typeof value !== 'string' || value.length < 16) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, 'base64').length > 0;
  } catch {
    return false;
  }
}

function findForbiddenSearchConfig(value, currentPath = '$', matches = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      findForbiddenSearchConfig(item, currentPath + '[' + index + ']', matches)
    );
    return matches;
  }

  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
      if (
        normalizedKey.includes('googlesearch') ||
        normalizedKey === 'grounding' ||
        normalizedKey.includes('groundingwithgooglesearch')
      ) {
        matches.push(currentPath + '.' + key);
      }
      findForbiddenSearchConfig(child, currentPath + '.' + key, matches);
    }
    return matches;
  }

  if (typeof value === 'string') {
    const normalizedValue = value.toLowerCase().replace(/[^a-z]/g, '');
    if (
      normalizedValue === 'googlesearch' ||
      normalizedValue === 'groundingwithgooglesearch'
    ) {
      matches.push(currentPath);
    }
  }

  return matches;
}

function evaluateSolverRequest(record) {
  const body = record.body || {};
  const image = findImagePart(body);
  const forbidden = findForbiddenSearchConfig(body);
  const isGateway = record.transport === 'gateway';
  const isLocal = record.transport === 'local';
  const requiresProviderConfig = !isGateway;
  const localAllowedFields = new Set([
    'model',
    'input',
    'stream',
    'store',
    'system_instruction',
    'tools',
    'generation_config',
    'previous_interaction_id'
  ]);
  const checks = {
    model:
      !requiresProviderConfig || body.model === MODEL,
    thinkingLevel:
      !requiresProviderConfig ||
      body.generation_config?.thinking_level === 'high',
    thinkingSummaries:
      !requiresProviderConfig ||
      body.generation_config?.thinking_summaries === 'auto',
    toolsExactlyCodeExecution:
      !requiresProviderConfig || (
        Array.isArray(body.tools) &&
        body.tools.length === 1 &&
        Object.keys(body.tools[0] || {}).length === 1 &&
        body.tools[0]?.type === 'code_execution'
      ),
    noGoogleSearchOrGrounding:
      forbidden.length === 0,
    imagePayload:
      !image || (
        image?.mime_type?.startsWith('image/') === true &&
        isBase64(image?.data)
      ),
    imageResolutionHigh:
      !image || image?.resolution === 'high',
    browserSentNoApiKey:
      !isGateway || record.browserContract?.sentNoApiKey === true,
    browserSentNoModelOrProviderConfig:
      !isGateway ||
      record.browserContract?.sentNoModelOrProviderConfig === true,
    browserUsedAllowedGatewayShape:
      !isGateway ||
      record.browserContract?.usedAllowedGatewayShape === true,
    localSentExpectedFakeKey:
      !isLocal || LOCAL_API_KEYS.includes(record.apiKey),
    localDidNotSendGatewaySlot:
      !isLocal || record.request?.gatewaySlotHeaderPresent === false,
    localUsedDirectCredentialHeader:
      !isLocal || record.request?.apiKeyHeaderPresent === true,
    localUsedExactFixedBody:
      !isLocal || (
        body.model === MODEL &&
        body.store === true &&
        typeof body.system_instruction === 'string' &&
        body.system_instruction.startsWith('Odgovaraj jasno, prirodno') &&
        body.system_instruction.length > 1000 &&
        Object.keys(body).every(key => localAllowedFields.has(key))
      )
  };

  return {
    requestId: record.id,
    scenario: record.scenario,
    transport: record.transport || 'legacy-direct',
    apiKey: record.apiKey,
    checks,
    ok: Object.values(checks).every(Boolean),
    forbiddenPaths: forbidden,
    image: image
      ? {
          mimeType: image.mime_type || '',
          base64Characters: String(image.data || '').length,
          decodedBytes: isBase64(image.data)
            ? Buffer.from(image.data, 'base64').length
            : 0
        }
      : null
  };
}

function evaluateRequests(requestLog, options = {}) {
  const scenario = options.scenario || '';
  const run = options.run || '';
  const relevant = requestLog.filter(record =>
    (!scenario || record.scenario === scenario) &&
    (!run || record.run === run)
  );
  const solverRecords = relevant.filter(record => record.kind === 'solve');
  const healthRecords = relevant.filter(record => record.kind === 'health');
  const gatewayRecords = solverRecords.filter(
    record => record.transport === 'gateway'
  );
  const localRecords = solverRecords.filter(
    record => record.transport === 'local'
  );
  const clientEvidence = (options.clientEvidenceLog || []).filter(record =>
    (!scenario || record.scenario === scenario) &&
    (!run || record.run === run)
  );
  const requestAssertions = solverRecords.map(evaluateSolverRequest);
  const scenarioChecks = {};

  if (scenario === 'success') {
    scenarioChecks.completedStream = solverRecords.some(
      record => record.response?.outcome === 'completed'
    );
  }

  if (scenario === 'gateway-success-local-unused') {
    scenarioChecks.gatewayCompleted =
      gatewayRecords.length === 1 &&
      gatewayRecords[0]?.response?.outcome === 'completed';
    scenarioChecks.gatewayWasMarked =
      gatewayRecords[0]?.request?.gatewayMarkerSent === true;
    scenarioChecks.configuredLocalWasNeverCalled = localRecords.length === 0;
  }

  if (scenario === 'gateway-marked-upstream-no-local') {
    scenarioChecks.markedUpstreamFailureWasReturned =
      gatewayRecords.length === 1 &&
      gatewayRecords[0]?.request?.gatewayMarkerSent === true &&
      gatewayRecords[0]?.response?.status === 400 &&
      gatewayRecords[0]?.response?.code === 'upstream_request_rejected';
    scenarioChecks.normalUpstreamFailureNeverCalledLocal =
      localRecords.length === 0;
  }

  if (scenario === 'gateway-sse-transport-error-no-fallback') {
    const first = gatewayRecords[0];
    scenarioChecks.receivedMarkedGatewaySseTransportError =
      first?.request?.gatewayMarkerSent === true &&
      first?.response?.status === 200 &&
      first?.response?.outcome === 'gateway-sse-transport-error' &&
      first?.response?.code === 502 &&
      first?.response?.streamStatus === 'UNAVAILABLE';
    scenarioChecks.exactlyOneGatewayPost = gatewayRecords.length === 1;
    scenarioChecks.zeroSyncRecovery =
      !solverRecords.some(record => record.body?.stream === false);
    scenarioChecks.zeroOtherGatewaySlot =
      gatewayRecords.every(record => record.apiKey === 'e2e-api-1');
    scenarioChecks.zeroLocalFallback = localRecords.length === 0;
  }

  if (scenario === 'gateway-rate-control-local') {
    scenarioChecks.rateControlFailureWasMarked =
      gatewayRecords.length === 1 &&
      gatewayRecords[0]?.request?.gatewayMarkerSent === true &&
      gatewayRecords[0]?.response?.code === 'rate_control_unavailable';
    scenarioChecks.transitionedToFirstLocalKey =
      localRecords.length === 1 &&
      localRecords[0]?.apiKey === LOCAL_API_KEYS[0] &&
      localRecords[0]?.response?.outcome === 'completed';
    scenarioChecks.gatewayPrecededLocal =
      gatewayRecords[0]?.id < localRecords[0]?.id;
  }

  if (scenario === 'gateway-unmarked-deployment-local') {
    scenarioChecks.deploymentErrorWasUnmarked =
      gatewayRecords.length === 1 &&
      gatewayRecords[0]?.request?.gatewayMarkerSent === false &&
      gatewayRecords[0]?.response?.outcome === 'unmarked-deployment-error';
    scenarioChecks.unmarkedResponseTransitionedLocal =
      localRecords.length === 1 &&
      localRecords[0]?.apiKey === LOCAL_API_KEYS[0] &&
      localRecords[0]?.response?.outcome === 'completed';
  }

  if (scenario === 'gateway-fetch-health-fail-local') {
    scenarioChecks.initialGatewayPostNeverReachedServer =
      gatewayRecords.length === 0;
    scenarioChecks.failedHealthProbeWasObserved =
      healthRecords.length === 1 &&
      healthRecords[0]?.response?.status === 503 &&
      healthRecords[0]?.request?.gatewayMarkerSent === false;
    scenarioChecks.failedHealthTransitionedLocal =
      localRecords.length === 1 &&
      localRecords[0]?.apiKey === LOCAL_API_KEYS[0] &&
      localRecords[0]?.response?.outcome === 'completed';
    scenarioChecks.healthProbePrecededLocal =
      healthRecords[0]?.id < localRecords[0]?.id;
  }

  if (scenario === 'local-key-fallback-order') {
    const localOrder = localRecords.map(record => [
      record.apiKey,
      String(record.body?.model || '')
    ]);
    scenarioChecks.gatewayFailurePrecededLocalKeys =
      gatewayRecords.length === 1 &&
      gatewayRecords[0]?.response?.code === 'rate_control_unavailable' &&
      gatewayRecords[0]?.id < localRecords[0]?.id;
    scenarioChecks.localKeyOneFailedThenKeyTwoCompleted =
      JSON.stringify(localOrder) === JSON.stringify([
        [LOCAL_API_KEYS[0], MODEL],
        [LOCAL_API_KEYS[1], MODEL]
      ]) &&
      localRecords[0]?.response?.status === 401 &&
      localRecords[0]?.response?.outcome === 'local-key-eligible-failure' &&
      localRecords[1]?.response?.outcome === 'completed';
    scenarioChecks.localBodiesAndHeadersMatchExactly =
      localRecords.length === 2 &&
      localRecords.every(record =>
        record.request?.apiKeyHeaderPresent === true &&
        record.request?.gatewaySlotHeaderPresent === false &&
        record.body?.model === MODEL &&
        record.body?.store === true &&
        record.body?.generation_config?.thinking_level === 'high' &&
        record.body?.generation_config?.thinking_summaries === 'auto' &&
        JSON.stringify(record.body?.tools) ===
          JSON.stringify([{ type: 'code_execution' }])
      ) &&
      localRecords[0]?.body?.system_instruction ===
        localRecords[1]?.body?.system_instruction;
  }

  if (scenario === 'gateway-down-no-local-keys') {
    scenarioChecks.gatewayInfrastructureFailureWasReturned =
      gatewayRecords.length === 1 &&
      gatewayRecords[0]?.response?.code === 'rate_control_unavailable';
    scenarioChecks.zeroLocalKeysMadeNoDirectRequest =
      localRecords.length === 0;
  }

  if (scenario === 'fallback-429') {
    const api1 = solverRecords.filter(record => record.apiKey === 'e2e-api-1');
    const api2 = solverRecords.filter(record => record.apiKey === 'e2e-api-2');
    scenarioChecks.api1Returned429 =
      api1.length > 0 &&
      api1.every(record => record.response?.status === 429);
    scenarioChecks.api2Completed =
      api2.some(record => record.response?.outcome === 'completed');
    scenarioChecks.api1WasBeforeApi2 =
      api1.length > 0 &&
      api2.length > 0 &&
      Math.max(...api1.map(record => record.id)) <
        Math.min(...api2.map(record => record.id));
  }

  if (scenario === 'fallback-four') {
    const actualOrder = solverRecords.map(record => [
      record.apiKey,
      String(record.body?.model || '')
    ]);
    scenarioChecks.exactFourProfileOrder =
      JSON.stringify(actualOrder) ===
      JSON.stringify(EXPECTED_FOUR_PROFILE_ORDER);
    scenarioChecks.firstThreeWereClassifiedFailures =
      solverRecords.length === 4 &&
      solverRecords.slice(0, 3).every(record =>
        record.response?.status === 401 &&
        record.response?.outcome === 'classified-profile-failure'
      );
    scenarioChecks.fourthProfileCompleted =
      solverRecords[3]?.response?.outcome === 'completed';
  }

  if (scenario === 'sse-error-next-profile') {
    const actualOrder = solverRecords.map(record => [
      record.apiKey,
      String(record.body?.model || '')
    ]);
    scenarioChecks.singleLineSseErrorWasSurfaced =
      solverRecords[0]?.response?.outcome === 'sse-error-modality' &&
      solverRecords[0]?.response?.singleLine === true &&
      solverRecords[0]?.response?.message === IMAGE_MODALITY_MESSAGE;
    scenarioChecks.advancedToNextOrderedTuple =
      JSON.stringify(actualOrder) === JSON.stringify([
        ['e2e-api-1', MODEL],
        ['e2e-api-2', MODEL]
      ]) &&
      solverRecords[1]?.response?.outcome === 'completed';
    scenarioChecks.noSyncDuplicateForSseError =
      !solverRecords.some(record => record.body?.stream === false);
  }

  if (scenario === 'terminal-failed-next-profile') {
    const actualOrder = solverRecords.map(record => [
      record.apiKey,
      String(record.body?.model || '')
    ]);
    scenarioChecks.failedCompletionErrorsWereSurfaced =
      solverRecords[0]?.response?.outcome === 'terminal-failed-modality' &&
      solverRecords[0]?.response?.message === IMAGE_MODALITY_MESSAGE;
    scenarioChecks.failedCompletionAdvancedDirectly =
      JSON.stringify(actualOrder) === JSON.stringify([
        ['e2e-api-1', MODEL],
        ['e2e-api-2', MODEL]
      ]) &&
      solverRecords[1]?.response?.outcome === 'completed';
    scenarioChecks.zeroSyncDuplicatesOnFailedTuple =
      !solverRecords.some(record =>
        record.apiKey === 'e2e-api-1' &&
        record.body?.model === MODEL &&
        record.body?.stream === false
      );
  }

  if (scenario === 'thought-high-demand-four') {
    const actualOrder = solverRecords.map(record => [
      record.apiKey,
      String(record.body?.model || '')
    ]);
    const failedAttempts = solverRecords.slice(0, 3);
    scenarioChecks.exactThoughtHighDemandFallbackOrder =
      JSON.stringify(actualOrder) ===
      JSON.stringify(EXPECTED_THOUGHT_HIGH_DEMAND_ORDER);
    scenarioChecks.allFailedTuplesHadThoughtButNoAnswer =
      failedAttempts.length === 3 &&
      failedAttempts.every(record =>
        /currently experiencing high demand/i.test(
          String(record.response?.message || '')
        ) &&
        record.response?.thoughtOutput === true &&
        record.response?.answerOutput === false
      );
    scenarioChecks.streamAndTerminalDemandErrorsWereHandled =
      failedAttempts.filter(record =>
        record.response?.failureShape === 'stream-error'
      ).length === 2 &&
      failedAttempts.filter(record =>
        record.response?.failureShape === 'terminal-failed'
      ).length === 1;
    scenarioChecks.fourthTupleCompleted =
      solverRecords[3]?.apiKey === 'e2e-api-4' &&
      solverRecords[3]?.body?.model === MODEL &&
      solverRecords[3]?.response?.outcome === 'completed';
    scenarioChecks.noSyncDuplicateDuringDemandFallback =
      !solverRecords.some(record => record.body?.stream === false);
  }

  if (scenario === 'answer-high-demand-no-fallback') {
    const first = solverRecords[0];
    scenarioChecks.answerThenHighDemandWasDelivered =
      first?.response?.outcome === 'answer-high-demand-stream-error' &&
      first?.response?.message === HIGH_DEMAND_MESSAGE &&
      first?.response?.thoughtOutput === true &&
      first?.response?.answerOutput === true;
    scenarioChecks.answerThenHighDemandStoppedImmediately =
      solverRecords.length === 1 &&
      first?.apiKey === 'e2e-api-1' &&
      first?.body?.model === MODEL;
  }

  if (scenario === 'payload-error-no-fallback') {
    scenarioChecks.payloadErrorWasSurfaced =
      solverRecords[0]?.response?.outcome === 'payload-error' &&
      solverRecords[0]?.response?.message ===
        UNSUPPORTED_IMAGE_PAYLOAD_MESSAGE;
    scenarioChecks.payloadErrorStoppedImmediately =
      solverRecords.length === 1 &&
      solverRecords[0]?.apiKey === 'e2e-api-1' &&
      solverRecords[0]?.body?.model === MODEL;
  }

  if (scenario === 'slow' && options.expectStop) {
    scenarioChecks.clientAbortedSlowStream = solverRecords.some(
      record =>
        record.response?.closedEarly === true &&
        record.response?.eventsSent > 0
    );
    scenarioChecks.stopDidNotContinueProfiles = solverRecords.length === 1;
  }

  if (scenario === 'partial-no-continue') {
    scenarioChecks.partialOutputWasDelivered =
      solverRecords[0]?.response?.outcome === 'server-disconnected-partial' &&
      solverRecords[0]?.response?.partialOutput === true &&
      Number(solverRecords[0]?.response?.eventsSent || 0) > 0;
    scenarioChecks.partialOutputDidNotContinueProfiles =
      solverRecords.length === 1;
  }

  if (scenario === 'retry-after-reload') {
    const api1 = solverRecords.filter(record => record.apiKey === 'e2e-api-1');
    const api2 = solverRecords.filter(record => record.apiKey === 'e2e-api-2');
    const first = api1[0] || null;
    const retry = api1[1] || null;
    const firstImage = findImagePart(first?.body);
    const retryImage = findImagePart(retry?.body);
    const evidenceByLabel = label =>
      clientEvidence.find(record => record.body?.label === label)?.body || null;
    const reloaded = evidenceByLabel('after-reload-pending-open');
    const retryStarted = evidenceByLabel('retry-request-started');
    const completed = evidenceByLabel('after-retry-completed');
    const afterCompletedSend = evidenceByLabel('after-completed-empty-send');

    scenarioChecks.firstRequestAbortedForReload =
      first?.response?.outcome === 'client-aborted' &&
      first?.response?.closedEarly === true;
    scenarioChecks.savedUnansweredPromptSurvivedReload =
      reloaded?.storage?.chatFound === true &&
      reloaded?.storage?.matchingUserMessages === 1 &&
      reloaded?.storage?.modelMessages === 0 &&
      reloaded?.storage?.lastRole === 'user' &&
      reloaded?.storage?.savedPrompt === RETRY_PROMPT;
    scenarioChecks.savedRealImageSurvivedReload =
      reloaded?.storage?.hadImage === true &&
      reloaded?.storage?.imageIdPresent === true &&
      reloaded?.indexedImage?.found === true &&
      String(reloaded?.indexedImage?.mimeType || '').startsWith('image/') &&
      Number(reloaded?.indexedImage?.bytes || 0) > 100;
    scenarioChecks.retryPromptIsExact =
      findTextPart(retry?.body) === RETRY_PROMPT;
    scenarioChecks.retryImageIsByteExact = Boolean(
      firstImage &&
      retryImage &&
      firstImage.mime_type === retryImage.mime_type &&
      firstImage.data === retryImage.data
    );
    scenarioChecks.noDuplicateUserOnRetry =
      retryStarted?.storage?.matchingUserMessages === 1 &&
      retryStarted?.dom?.matchingUserBubbles === 1 &&
      completed?.storage?.matchingUserMessages === 1 &&
      completed?.dom?.matchingUserBubbles === 1;
    scenarioChecks.retryCompleted =
      retry?.response?.outcome === 'completed' &&
      completed?.storage?.completedModels >= 1 &&
      completed?.storage?.lastRole === 'model';
    scenarioChecks.completedAnswerIsNotResendable =
      api1.length === 2 &&
      afterCompletedSend?.storage?.matchingUserMessages === 1 &&
      afterCompletedSend?.storage?.completedModels >= 1 &&
      afterCompletedSend?.storage?.lastRole === 'model';
    scenarioChecks.noUnexpectedApi2 = api2.length === 0;
  }

  const hasSolverRequest = solverRecords.length > 0;
  const requestsOk =
    hasSolverRequest &&
    requestAssertions.every(assertion => assertion.ok);
  const scenarioOk =
    Object.values(scenarioChecks).every(Boolean);

  return {
    ok: requestsOk && scenarioOk,
    filters: {
      scenario: scenario || null,
      run: run || null,
      expectStop: Boolean(options.expectStop)
    },
    counts: {
      allMatchingRequests: relevant.length,
      solverRequests: solverRecords.length,
      gatewayRequests: gatewayRecords.length,
      localRequests: localRecords.length,
      healthRequests: healthRecords.length,
      clientEvidence: clientEvidence.length,
      solverRequestsWithImage: solverRecords.filter(record =>
        Boolean(findImagePart(record.body))
      ).length
    },
    scenarioChecks,
    requests: requestAssertions,
    clientEvidence
  };
}

function completedInteraction(id) {
  return {
    id,
    status: 'completed',
    steps: [
      {
        type: 'thought',
        summary: [
          {
            type: 'text',
            text:
              'Prepoznajem linearnu jednačinu i izolujem nepoznatu u dva koraka.'
          }
        ]
      },
      {
        type: 'model_output',
        content: [
          {
            type: 'text',
            text:
              'Oduzmemo 3 sa obe strane:\n\n\\[2x=8\\]\n\nPodelimo sa 2:\n\n\\[x=4\\]\n\n**Odgovor:** \\(x=4\\).'
          }
        ]
      }
    ]
  };
}

function ssePlan(scenario, interactionId) {
  const completed = {
    event_type: 'interaction.completed',
    interaction: completedInteraction(interactionId)
  };

  if (scenario === 'slow') {
    return [
      [0, { event_type: 'interaction.created', interaction: { id: interactionId } }],
      [80, { event_type: 'step.start', index: 0, step: { type: 'thought' } }],
      [
        350,
        {
          event_type: 'step.delta',
          index: 0,
          delta: {
            type: 'thought_summary',
            content: [
              {
                type: 'text',
                text: 'Čitam zadatak i izdvajam poznate veličine. '
              }
            ]
          }
        }
      ],
      [
        800,
        {
          event_type: 'step.delta',
          index: 0,
          delta: {
            type: 'thought_summary',
            content: [
              {
                type: 'text',
                text: 'Sada proveravam račun pre konačnog odgovora.'
              }
            ]
          }
        }
      ],
      [1100, { event_type: 'step.start', index: 1, step: { type: 'model_output' } }],
      [
        1500,
        {
          event_type: 'step.delta',
          index: 1,
          delta: {
            type: 'text',
            text: 'Oduzmemo 3 sa obe strane.\n\n'
          }
        }
      ],
      [
        3000,
        {
          event_type: 'step.delta',
          index: 1,
          delta: { type: 'text', text: '\\[2x=8\\]\n\n' }
        }
      ],
      [15000, completed]
    ];
  }

  return [
    [0, { event_type: 'interaction.created', interaction: { id: interactionId } }],
    [35, { event_type: 'step.start', index: 0, step: { type: 'thought' } }],
    [
      80,
      {
        event_type: 'step.delta',
        index: 0,
        delta: {
          type: 'thought_summary',
          content: [
            {
              type: 'text',
              text: 'Prepoznajem linearnu jednačinu. '
            }
          ]
        }
      }
    ],
    [
      130,
      {
        event_type: 'step.delta',
        index: 0,
        delta: {
          type: 'thought_summary',
          content: [
            {
              type: 'text',
              text: 'Izolujem nepoznatu i proveravam rezultat.'
            }
          ]
        }
      }
    ],
    [180, { event_type: 'step.start', index: 1, step: { type: 'model_output' } }],
    [
      230,
      {
        event_type: 'step.delta',
        index: 1,
        delta: {
          type: 'text',
          text: 'Oduzmemo 3 sa obe strane.\n\n'
        }
      }
    ],
    [
      280,
      {
        event_type: 'step.delta',
        index: 1,
        delta: {
          type: 'text',
          text: '\\[2x=8\\]\n\nZato je \\(x=4\\).'
        }
      }
    ],
    [360, completed]
  ];
}

function streamInteraction(res, record) {
  const timers = new Set();
  const interactionId =
    'mock-' + record.scenario + '-' + String(record.id).padStart(3, '0');
  const plan = ssePlan(record.scenario, interactionId);

  record.response = {
    status: 200,
    outcome: 'streaming',
    eventsSent: 0,
    closedEarly: false
  };

  res.writeHead(200, {
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write(': deterministic Gemini mock\n\n');

  const cleanup = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };

  res.once('close', () => {
    if (!res.writableEnded) {
      record.response.closedEarly = true;
      record.response.outcome = 'client-aborted';
    }
    cleanup();
  });

  for (const [delay, event] of plan) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (res.destroyed || res.writableEnded) return;

      res.write('data: ' + JSON.stringify(event) + '\n\n');
      record.response.eventsSent += 1;

      if (event.event_type === 'interaction.completed') {
        record.response.outcome = 'completed';
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }, delay);
    timers.add(timer);
  }
}

function holdInteractionUntilReload(res, record) {
  record.response = {
    status: 200,
    outcome: 'streaming-unanswered',
    eventsSent: 0,
    closedEarly: false
  };

  res.writeHead(200, {
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write(': waiting for deterministic reload\n\n');

  const safetyTimer = setTimeout(() => {
    if (res.destroyed || res.writableEnded) return;
    record.response.outcome = 'reload-not-observed';
    res.end();
  }, 30000);
  safetyTimer.unref?.();

  res.once('close', () => {
    clearTimeout(safetyTimer);
    if (!res.writableEnded) {
      record.response.closedEarly = true;
      record.response.outcome = 'client-aborted';
    }
  });
}

function streamPartialThenDisconnect(res, record) {
  const timers = new Set();
  const interactionId =
    'mock-partial-' + String(record.id).padStart(3, '0');
  const events = [
    [0, {
      event_type: 'interaction.created',
      interaction: { id: interactionId }
    }],
    [35, {
      event_type: 'step.start',
      index: 0,
      step: { type: 'thought' }
    }],
    [75, {
      event_type: 'step.delta',
      index: 0,
      delta: {
        type: 'thought_summary',
        content: [{
          type: 'text',
          text: 'Parcijalno razmišljanje je već prikazano. '
        }]
      }
    }],
    [115, {
      event_type: 'step.start',
      index: 1,
      step: { type: 'model_output' }
    }],
    [155, {
      event_type: 'step.delta',
      index: 1,
      delta: {
        type: 'text',
        text: 'Ovaj deo odgovora mora ostati bez prelaska na drugi profil.'
      }
    }]
  ];

  record.response = {
    status: 200,
    outcome: 'streaming-partial',
    eventsSent: 0,
    closedEarly: false,
    partialOutput: false
  };

  res.writeHead(200, {
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write(': deterministic partial stream\n\n');

  const cleanup = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };

  res.once('close', () => {
    if (record.response.outcome === 'streaming-partial') {
      record.response.closedEarly = true;
      record.response.outcome = 'client-aborted-partial';
    }
    cleanup();
  });

  for (const [delay, event] of events) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (res.destroyed || res.writableEnded) return;
      res.write('data: ' + JSON.stringify(event) + '\n\n');
      record.response.eventsSent += 1;
      if (event.event_type === 'step.delta' && event.index === 1) {
        record.response.partialOutput = true;
      }
    }, delay);
    timers.add(timer);
  }

  const disconnectTimer = setTimeout(() => {
    timers.delete(disconnectTimer);
    if (res.destroyed || res.writableEnded) return;
    record.response.closedEarly = true;
    record.response.outcome = 'server-disconnected-partial';
    res.destroy();
  }, 210);
  timers.add(disconnectTimer);
}

function sendSingleLineSseError(res, record, message, outcome) {
  const event = {
    event_type: 'error',
    error: {
      code: 400,
      status: 'INVALID_ARGUMENT',
      message
    }
  };

  record.response = {
    status: 200,
    outcome,
    eventsSent: 1,
    closedEarly: false,
    singleLine: true,
    message
  };

  res.writeHead(200, {
    'Cache-Control': 'no-cache, no-store',
    'Content-Type': 'text/event-stream; charset=utf-8'
  });
  // Deliberately no blank SSE separator: this reproduces the observed wire
  // shape and exercises the parser's one-data-line fast path.
  res.end('data: ' + JSON.stringify(event) + '\n');
}

function sendGatewayTransportSseError(res, record) {
  const message =
    'The marked gateway stream became unavailable before any output.';
  const event = {
    event_type: 'error',
    error: {
      code: 502,
      status: 'UNAVAILABLE',
      message
    }
  };

  record.response = {
    status: 200,
    outcome: 'gateway-sse-transport-error',
    code: 502,
    streamStatus: 'UNAVAILABLE',
    eventsSent: 1,
    closedEarly: false,
    singleLine: true,
    message
  };

  res.writeHead(200, {
    'Cache-Control': 'no-cache, no-store',
    'Content-Type': 'text/event-stream; charset=utf-8'
  });
  res.end('data: ' + JSON.stringify(event) + '\n');
}

function sendTerminalFailedCompletion(res, record) {
  const event = {
    event_type: 'interaction.completed',
    interaction: {
      id: 'mock-terminal-failed-' + String(record.id).padStart(3, '0'),
      status: 'failed',
      errors: [
        {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: IMAGE_MODALITY_MESSAGE
        }
      ]
    }
  };

  record.response = {
    status: 200,
    outcome: 'terminal-failed-modality',
    eventsSent: 1,
    closedEarly: false,
    message: IMAGE_MODALITY_MESSAGE
  };

  res.writeHead(200, {
    'Cache-Control': 'no-cache, no-store',
    'Content-Type': 'text/event-stream; charset=utf-8'
  });
  res.end(
    'data: ' + JSON.stringify(event) + '\n\n' +
    'data: [DONE]\n\n'
  );
}

function streamThoughtThenHighDemand(
  res,
  record,
  failureShape,
  includeAnswer = false
) {
  const interactionId =
    'mock-thought-demand-' + String(record.id).padStart(3, '0');
  const message = HIGH_DEMAND_MESSAGE;
  const events = [
    {
      event_type: 'interaction.created',
      interaction: { id: interactionId }
    },
    {
      event_type: 'step.start',
      index: 0,
      step: { type: 'thought' }
    },
    {
      event_type: 'step.delta',
      index: 0,
      delta: {
        type: 'thought_summary',
        content: [{
          type: 'text',
          text: 'Analiziram zadatak pre nego što sastavim odgovor. '
        }]
      }
    }
  ];

  if (includeAnswer) {
    events.push(
      {
        event_type: 'step.start',
        index: 1,
        step: { type: 'model_output' }
      },
      {
        event_type: 'step.delta',
        index: 1,
        delta: {
          type: 'text',
          text: 'Ovo je već započeti konačni odgovor. '
        }
      }
    );
  }

  if (failureShape === 'terminal-failed') {
    events.push({
      event_type: 'interaction.completed',
      interaction: {
        id: interactionId,
        status: 'failed',
        errors: [{
          code: 503,
          status: 'UNAVAILABLE',
          message
        }]
      }
    });
  } else {
    events.push({
      event_type: 'error',
      error: {
        code: 503,
        status: 'UNAVAILABLE',
        message
      }
    });
  }

  record.response = {
    status: 200,
    outcome: includeAnswer
      ? 'answer-high-demand-' + failureShape
      : 'thought-high-demand-' + failureShape,
    eventsSent: events.length,
    closedEarly: false,
    message,
    failureShape,
    thoughtOutput: true,
    answerOutput: includeAnswer
  };

  res.writeHead(200, {
    'Cache-Control': 'no-cache, no-store',
    'Content-Type': 'text/event-stream; charset=utf-8'
  });
  res.end(
    events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') +
    'data: [DONE]\n\n'
  );
}

function harnessBootstrap() {
  const lines = [
    '<script id="math-e2e-bootstrap">',
    '(function () {',
    '  var params = new URLSearchParams(location.search);',
    '  var allowed = ' + JSON.stringify([...VALID_SCENARIOS]) + ';',
    '  var localFallbackScenarios = ' +
      JSON.stringify([...LOCAL_FALLBACK_SCENARIOS]) + ';',
    '  var localKeys = ' + JSON.stringify(LOCAL_API_KEYS) + ';',
    '  var scenario = params.get("scenario") || "success";',
    '  if (allowed.indexOf(scenario) === -1) scenario = "success";',
    '  var runId = params.get("run") || scenario;',
    '  var freshKey = "math-e2e-fresh:" + scenario + ":" + runId;',
    '  if (params.get("fresh") !== "0" && sessionStorage.getItem(freshKey) !== "1") {',
    '    localStorage.clear();',
    '    sessionStorage.setItem(freshKey, "1");',
    '  }',
    '  if (localFallbackScenarios.indexOf(scenario) !== -1) {',
    '    localStorage.setItem("matematika_local_api_fallback_v1", JSON.stringify(localKeys.map(function (key) { return { key: key }; })));',
    '  } else if (scenario === "gateway-down-no-local-keys") {',
    '    localStorage.setItem("matematika_local_api_fallback_v1", JSON.stringify([{ key: "" }, { key: "" }, { key: "" }, { key: "" }]));',
    '  }',
    '  var realFetch = window.fetch.bind(window);',
    '  function parsedUrl(raw) {',
    '    try { return new URL(raw, location.href); } catch (error) { return null; }',
    '  }',
    '  function isLocalUpstream(raw) {',
    '    var url = parsedUrl(raw);',
    '    var host = ["generative", "language.", "google", "apis.com"].join("");',
    '    return !!url && url.hostname === host && url.pathname === "/v1beta/interactions";',
    '  }',
    '  window.fetch = function (input, init) {',
    '    var raw = typeof input === "string"',
    '      ? input',
    '      : input && input.url ? input.url : String(input || "");',
    '    if (raw.indexOf("/__mock/gateway/v1/interactions") !== -1) {',
    '      if (scenario === "gateway-fetch-health-fail-local") {',
    '        return Promise.reject(new TypeError("Deterministic gateway fetch failure."));',
    '      }',
    '      if (scenario === "retry-after-reload" && window.__MATH_E2E_RETRY__?.onGeminiRequest) {',
    '        try { window.__MATH_E2E_RETRY__.onGeminiRequest(); } catch (error) {',
    '          console.error("[Math E2E retry request hook]", error);',
    '        }',
    '      }',
    '    }',
    '    if (isLocalUpstream(raw)) {',
    '      var upstream = parsedUrl(raw);',
    '      var rewritten = new URL("/__mock/local/v1beta/interactions", location.origin);',
    '      rewritten.search = upstream.search;',
    '      rewritten.searchParams.set("scenario", scenario);',
    '      rewritten.searchParams.set("run", runId);',
    '      return realFetch(rewritten.href, init);',
    '    }',
    '    return realFetch(input, init);',
    '  };',
    '  window.__MATH_E2E__ = {',
    '    scenario: scenario,',
    '    runId: runId,',
    '    requests: "/__harness__/requests?scenario=" + encodeURIComponent(scenario) + "&run=" + encodeURIComponent(runId),',
    '    assertions: "/__harness__/assertions?scenario=" + encodeURIComponent(scenario) + "&run=" + encodeURIComponent(runId)',
    '  };',
    '  if (scenario === "retry-after-reload") {',
    '    var originalDocumentWrite = Document.prototype.write;',
    '    Document.prototype.write = function () {',
    '      var args = Array.prototype.slice.call(arguments);',
    '      Document.prototype.write = originalDocumentWrite;',
    '      var tag = "<scr" + "ipt src=\\\"/__harness__/retry-after-reload-driver.js\\\"></scr" + "ipt>";',
    '      args = args.map(function (value) {',
    '        return typeof value === "string"',
    '          ? value.replace(/<\\/body>/i, tag + "</body>")',
    '          : value;',
    '      });',
    '      return originalDocumentWrite.apply(this, args);',
    '    };',
    '  }',
    '  if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {',
    '    navigator.serviceWorker.getRegistrations().then(function (items) {',
    '      items.forEach(function (registration) { registration.unregister(); });',
    '    }).catch(function () {});',
    '  }',
    '  console.info("[Math E2E harness]", window.__MATH_E2E__);',
    '})();',
    '</script>'
  ];
  return lines.join('\n');
}

function injectHarness(indexHtml) {
  const match = indexHtml.match(/<body(?:\s[^>]*)?>/i);
  if (!match || match.index === undefined) {
    throw new Error('Cannot inject the E2E bootstrap: docs/index.html has no body.');
  }
  const insertionPoint = match.index + match[0].length;
  return (
    indexHtml.slice(0, insertionPoint) +
    '\n' +
    harnessBootstrap() +
    '\n' +
    indexHtml.slice(insertionPoint)
  );
}

function dashboardHtml(host, port) {
  const base = 'http://' + host + ':' + port;
  const retryRun = 'retry-' + Date.now();
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Math app E2E harness</title>',
    '<style>',
    'body{font:16px system-ui,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;color:#172033}',
    'a{color:#0b63ce}li{margin:12px 0}code{background:#eef2f7;padding:2px 5px;border-radius:5px}',
    '.card{border:1px solid #d9e0ea;border-radius:14px;padding:18px 22px;margin:18px 0}',
    '</style></head><body>',
    '<h1>Math app deterministic E2E harness</h1>',
    '<div class="card"><h2>Scenarios</h2><ul>',
    '<li><a href="' + base + '/docs/?scenario=success&fresh=1">Success stream</a></li>',
    '<li><a href="' + base + '/docs/?scenario=slow&fresh=1">Slow stream for Stop</a></li>',
    '<li><a href="' + base + '/docs/?scenario=fallback-429&fresh=1">API 1 returns 429, API 2 succeeds</a></li>',
    '<li><a href="' + base + '/docs/?scenario=fallback-four&fresh=1">Exact 4-profile fallback order</a></li>',
    '<li><a href="' + base + '/docs/?scenario=partial-no-continue&fresh=1">Partial output must not continue</a></li>',
    '<li><a href="' + base + '/docs/?scenario=sse-error-next-profile&fresh=1">Single-line SSE modality error advances</a></li>',
    '<li><a href="' + base + '/docs/?scenario=terminal-failed-next-profile&fresh=1">Failed completion advances without sync duplicate</a></li>',
    '<li><a href="' + base + '/docs/?scenario=thought-high-demand-four&fresh=1">Thinking-only high demand reaches API 4</a></li>',
    '<li><a href="' + base + '/docs/?scenario=answer-high-demand-no-fallback&fresh=1">Answer then high demand must not continue</a></li>',
    '<li><a href="' + base + '/docs/?scenario=payload-error-no-fallback&fresh=1">Unsupported image payload must stop</a></li>',
    '<li><a href="' + base + '/docs/source.html?scenario=gateway-success-local-unused&fresh=1">Gateway success never uses configured local keys</a></li>',
    '<li><a href="' + base + '/docs/source.html?scenario=gateway-marked-upstream-no-local&fresh=1">Marked upstream rejection never uses local keys</a></li>',
    '<li><a href="' + base + '/docs/source.html?scenario=gateway-sse-transport-error-no-fallback&fresh=1">Marked gateway SSE transport error stops all fallback</a></li>',
    '<li><a href="' + base + '/docs/source.html?scenario=gateway-rate-control-local&fresh=1">Rate coordinator failure uses local fallback</a></li>',
    '<li><a href="' + base + '/docs/source.html?scenario=gateway-unmarked-deployment-local&fresh=1">Unmarked deployment error uses local fallback</a></li>',
    '<li><a href="' + base + '/docs/source.html?scenario=gateway-fetch-health-fail-local&fresh=1">Fetch plus health failure uses local fallback</a></li>',
    '<li><a href="' + base + '/docs/source.html?scenario=local-key-fallback-order&fresh=1">Local key 1 fails, local key 2 succeeds</a></li>',
    '<li><a href="' + base + '/docs/source.html?scenario=gateway-down-no-local-keys&fresh=1">Gateway down with zero local keys</a></li>',
    '<li><a href="' + base + '/docs/?scenario=retry-after-reload&fresh=1&run=' + retryRun + '">Reload then empty-Send retry (automatic)</a></li>',
    '</ul></div>',
    '<div class="card"><h2>Evidence</h2><ul>',
    '<li><a href="/__harness__/requests">Recorded request JSON</a></li>',
    '<li><a href="/__harness__/assertions">All request assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=success">Success assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=fallback-429">Fallback assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=fallback-four">4-profile order assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=partial-no-continue">Partial/no-continuation assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=sse-error-next-profile">SSE error propagation assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=terminal-failed-next-profile">Failed completion assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=thought-high-demand-four">Thinking-only high-demand assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=answer-high-demand-no-fallback">Answer/high-demand guard assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=payload-error-no-fallback">Payload classifier assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=gateway-success-local-unused">Gateway-primary assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=gateway-marked-upstream-no-local">Marked-upstream assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=gateway-sse-transport-error-no-fallback">Gateway SSE transport-error assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=gateway-rate-control-local">Rate-control local assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=gateway-unmarked-deployment-local">Unmarked-deployment assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=gateway-fetch-health-fail-local">Gateway health-failure assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=local-key-fallback-order">Local ordered-key assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=gateway-down-no-local-keys">Zero-local-key assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=slow&expectStop=1">Stop/abort assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=retry-after-reload&run=' + retryRun + '">Reload/retry assertions</a></li>',
    '<li><a href="/__harness__/reset">Reset recorded evidence</a></li>',
    '<li><a href="/tests/e2e/fixtures/linear-equation.png">Synthetic math image (PNG)</a></li>',
    '</ul></div>',
    '<p>No network request is sent to Gemini. The browser URL is rewritten in memory to the same-origin mock.</p>',
    '</body></html>'
  ].join('');
}

async function serveFile(res, absolutePath, options = {}) {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      sendText(res, 404, 'Not found.');
      return;
    }
    let content = await fs.readFile(absolutePath);
    if (options.transform) content = await options.transform(content);
    const contentType =
      MIME_TYPES.get(path.extname(absolutePath).toLowerCase()) ||
      'application/octet-stream';
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': contentType,
      'Content-Length': content.length
    });
    res.end(content);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      sendText(res, 404, 'Not found.');
      return;
    }
    throw error;
  }
}

function safeFile(baseDir, relativePath) {
  const decoded = decodeURIComponent(relativePath);
  const candidate = path.resolve(baseDir, decoded);
  if (
    candidate !== baseDir &&
    !candidate.startsWith(baseDir + path.sep)
  ) {
    return null;
  }
  return candidate;
}

export function createHarnessServer() {
  const requestLog = [];
  const clientEvidenceLog = [];
  let nextRequestId = 1;
  let nextClientEvidenceId = 1;

  const server = http.createServer(async (req, res) => {
    try {
      const authority = req.headers.host || DEFAULT_HOST;
      const url = new URL(req.url || '/', 'http://' + authority);

      if (url.pathname === '/') {
        res.writeHead(302, {
          'Cache-Control': 'no-store',
          'Location': '/__harness__/'
        });
        res.end();
        return;
      }

      if (url.pathname === '/__harness__/' || url.pathname === '/__harness__') {
        const address = server.address();
        const host =
          typeof address === 'object' && address ? address.address : DEFAULT_HOST;
        const port =
          typeof address === 'object' && address ? address.port : DEFAULT_PORT;
        sendText(res, 200, dashboardHtml(host, port), 'text/html; charset=utf-8');
        return;
      }

      if (url.pathname === '/__harness__/reset') {
        requestLog.length = 0;
        clientEvidenceLog.length = 0;
        nextRequestId = 1;
        nextClientEvidenceId = 1;
        if (req.method === 'GET') {
          sendText(
            res,
            200,
            '<!doctype html><meta charset="utf-8"><p>Evidence reset.</p><p><a href="/__harness__/">Back to harness</a></p>',
            'text/html; charset=utf-8'
          );
        } else {
          sendJson(res, 200, { ok: true });
        }
        return;
      }

      if (url.pathname === '/__harness__/requests') {
        const requestedScenario = url.searchParams.get('scenario') || '';
        const requestedRun = url.searchParams.get('run') || '';
        const records = requestLog.filter(record =>
          (!requestedScenario || record.scenario === requestedScenario) &&
          (!requestedRun || record.run === requestedRun)
        );
        sendJson(res, 200, { count: records.length, requests: records });
        return;
      }

      if (url.pathname === '/__harness__/client-evidence') {
        const requestedScenario = url.searchParams.get('scenario') || '';
        const requestedRun = url.searchParams.get('run') || '';

        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          const record = {
            id: nextClientEvidenceId++,
            receivedAt: new Date().toISOString(),
            scenario: requestedScenario,
            run: requestedRun,
            body
          };
          clientEvidenceLog.push(record);
          sendJson(res, 200, { ok: true, id: record.id });
          return;
        }

        if (req.method !== 'GET') {
          sendJson(res, 405, { error: { message: 'GET or POST required.' } });
          return;
        }

        const records = clientEvidenceLog.filter(record =>
          (!requestedScenario || record.scenario === requestedScenario) &&
          (!requestedRun || record.run === requestedRun)
        );
        sendJson(res, 200, { count: records.length, evidence: records });
        return;
      }

      if (url.pathname === '/__harness__/assertions') {
        sendJson(
          res,
          200,
          evaluateRequests(requestLog, {
            scenario: url.searchParams.get('scenario') || '',
            run: url.searchParams.get('run') || '',
            expectStop: url.searchParams.get('expectStop') === '1',
            clientEvidenceLog
          })
        );
        return;
      }

      if (url.pathname === '/__mock/gateway/health') {
        const scenario = scenarioFrom(url);
        const run = url.searchParams.get('run') || '';
        const healthFails =
          scenario === 'gateway-fetch-health-fail-local';
        const markerSent = !healthFails;
        if (markerSent) res.setHeader('X-Math-Gateway', '1');

        const record = {
          id: nextRequestId++,
          receivedAt: new Date().toISOString(),
          run,
          scenario,
          kind: 'health',
          transport: 'gateway',
          request: {
            method: req.method,
            path: url.pathname,
            gatewayMarkerSent: markerSent
          },
          response: healthFails
            ? { status: 503, outcome: 'health-unavailable' }
            : { status: 200, outcome: 'healthy' }
        };
        requestLog.push(record);

        if (req.method !== 'GET') {
          record.response = { status: 405, outcome: 'health-method-rejected' };
          sendJson(res, 405, { error: { message: 'GET required.' } });
          return;
        }

        if (healthFails) {
          sendJson(res, 503, {
            error: {
              code: 'gateway_health_unavailable',
              message: 'Deterministic failed gateway health probe.'
            }
          });
          return;
        }

        sendJson(res, 200, { ok: true });
        return;
      }

      if (
        url.pathname === '/__mock/gemini/v1beta/interactions' ||
        url.pathname === '/__mock/gateway/v1/interactions' ||
        url.pathname === '/__mock/local/v1beta/interactions'
      ) {
        const isGateway = url.pathname === '/__mock/gateway/v1/interactions';
        const isLocal = url.pathname === '/__mock/local/v1beta/interactions';
        const scenario = scenarioFrom(url);
        const gatewayMarkerSent =
          isGateway && scenario !== 'gateway-unmarked-deployment-local';
        if (gatewayMarkerSent) res.setHeader('X-Math-Gateway', '1');

        if (req.method !== 'POST') {
          sendJson(res, 405, { error: { message: 'POST required.' } });
          return;
        }

        const incomingBody = await readJsonBody(req);
        const slot = String(req.headers['x-math-api-slot'] || '');
        const apiKey = isGateway
          ? 'e2e-api-' + slot
          : String(req.headers['x-goog-api-key'] || '');
        const browserAllowedFields = new Set([
          'input',
          'stream',
          'previous_interaction_id'
        ]);
        const browserContract = isGateway
          ? {
              sentNoApiKey:
                !Object.hasOwn(req.headers, 'x-goog-api-key'),
              sentNoModelOrProviderConfig:
                !Object.hasOwn(incomingBody, 'model') &&
                !Object.hasOwn(incomingBody, 'system_instruction') &&
                !Object.hasOwn(incomingBody, 'tools') &&
                !Object.hasOwn(incomingBody, 'generation_config'),
              usedAllowedGatewayShape:
                /^[1-4]$/.test(slot) &&
                Object.keys(incomingBody).every(key =>
                  browserAllowedFields.has(key)
                )
            }
          : isLocal
            ? {
                sentExpectedLocalApiKey:
                  LOCAL_API_KEYS.includes(apiKey),
                sentNoGatewaySlot:
                  !Object.hasOwn(req.headers, 'x-math-api-slot'),
                sentFixedLocalConfig:
                  incomingBody?.model === MODEL &&
                  incomingBody?.store === true &&
                  incomingBody?.generation_config?.thinking_level === 'high' &&
                  incomingBody?.generation_config?.thinking_summaries === 'auto'
              }
            : null;
        const body = isGateway
          ? {
              ...incomingBody,
              model: MODEL,
              store: true,
              system_instruction: 'Deterministic fixed server-side instruction.',
              tools: [{ type: 'code_execution' }],
              generation_config: {
                thinking_level: 'high',
                thinking_summaries: 'auto'
              }
            }
          : incomingBody;
        const run = url.searchParams.get('run') || '';
        const scenarioRequestIndex = requestLog.filter(record =>
          record.kind === 'solve' &&
          record.scenario === scenario &&
          record.run === run
        ).length + 1;
        const record = {
          id: nextRequestId++,
          receivedAt: new Date().toISOString(),
          run,
          scenario,
          scenarioRequestIndex,
          kind: 'solve',
          transport: isGateway
            ? 'gateway'
            : isLocal
              ? 'local'
              : 'legacy-direct',
          apiKey,
          browserContract,
          request: {
            method: req.method,
            path: url.pathname,
            alt: url.searchParams.get('alt') || '',
            accept: String(req.headers.accept || ''),
            contentType: String(req.headers['content-type'] || ''),
            apiKeyHeaderPresent:
              Object.hasOwn(req.headers, 'x-goog-api-key'),
            gatewaySlotHeaderPresent:
              Object.hasOwn(req.headers, 'x-math-api-slot'),
            gatewayMarkerSent
          },
          body,
          response: null
        };
        requestLog.push(record);

        if (scenario === 'gateway-sse-transport-error-no-fallback') {
          const isExpectedFirstGatewayPost =
            isGateway &&
            scenarioRequestIndex === 1 &&
            slot === '1' &&
            incomingBody?.stream === true;

          if (isExpectedFirstGatewayPost) {
            sendGatewayTransportSseError(res, record);
            return;
          }

          record.response = {
            status: 409,
            code: 'unexpected_transport_continuation',
            outcome: 'unexpected-transport-continuation',
            eventsSent: 0,
            closedEarly: false
          };
          sendJson(res, 409, {
            error: {
              code: 'unexpected_transport_continuation',
              status: 409,
              message:
                'Gateway SSE transport failure must not trigger sync, another gateway slot, or local fallback.'
            }
          });
          return;
        }

        if (
          isGateway &&
          scenario === 'gateway-marked-upstream-no-local'
        ) {
          record.response = {
            status: 400,
            code: 'upstream_request_rejected',
            outcome: 'marked-normal-upstream-failure',
            eventsSent: 0,
            closedEarly: false
          };
          sendJson(res, 400, {
            error: {
              code: 'upstream_request_rejected',
              status: 400,
              message: 'The AI service rejected this deterministic request.'
            }
          });
          return;
        }

        if (
          isGateway &&
          [
            'gateway-rate-control-local',
            'local-key-fallback-order',
            'gateway-down-no-local-keys'
          ].includes(scenario)
        ) {
          record.response = {
            status: 503,
            code: 'rate_control_unavailable',
            outcome: 'gateway-rate-control-unavailable',
            eventsSent: 0,
            closedEarly: false
          };
          sendJson(res, 503, {
            error: {
              code: 'rate_control_unavailable',
              status: 503,
              message: 'Request rate control is temporarily unavailable.'
            }
          });
          return;
        }

        if (
          isGateway &&
          scenario === 'gateway-unmarked-deployment-local'
        ) {
          record.response = {
            status: 530,
            code: '',
            outcome: 'unmarked-deployment-error',
            eventsSent: 0,
            closedEarly: false
          };
          sendText(
            res,
            530,
            'Deterministic unmarked deployment failure.'
          );
          return;
        }

        if (isLocal && scenario === 'local-key-fallback-order') {
          if (apiKey === LOCAL_API_KEYS[0]) {
            record.response = {
              status: 401,
              code: 'UNAUTHENTICATED',
              outcome: 'local-key-eligible-failure',
              eventsSent: 0,
              closedEarly: false
            };
            sendJson(res, 401, {
              error: {
                code: 'UNAUTHENTICATED',
                status: 401,
                message: 'Deterministic local API key 1 was rejected.'
              }
            });
            return;
          }

          if (apiKey !== LOCAL_API_KEYS[1]) {
            record.response = {
              status: 409,
              code: 'unexpected_local_key',
              outcome: 'unexpected-local-key-order',
              eventsSent: 0,
              closedEarly: false
            };
            sendJson(res, 409, {
              error: {
                code: 'unexpected_local_key',
                status: 409,
                message: 'Expected local API key 2 after local API key 1.'
              }
            });
            return;
          }
        }

        if (
          isLocal &&
          [
            'gateway-rate-control-local',
            'gateway-unmarked-deployment-local',
            'gateway-fetch-health-fail-local'
          ].includes(scenario) &&
          apiKey !== LOCAL_API_KEYS[0]
        ) {
          record.response = {
            status: 409,
            code: 'unexpected_local_key',
            outcome: 'unexpected-local-key-order',
            eventsSent: 0,
            closedEarly: false
          };
          sendJson(res, 409, {
            error: {
              code: 'unexpected_local_key',
              status: 409,
              message: 'Expected the first configured local API key.'
            }
          });
          return;
        }

        if (
          scenario === 'retry-after-reload' &&
          apiKey === 'e2e-api-2'
        ) {
          record.response = {
            status: 409,
            outcome: 'unexpected-api2',
            eventsSent: 0,
            closedEarly: false
          };
          sendJson(res, 409, {
            error: {
              code: 409,
              status: 'FAILED_PRECONDITION',
              message: 'Deterministic mock: API 2 must not be used for reload retry.'
            }
          });
          return;
        }

        if (
          scenario === 'retry-after-reload' &&
          apiKey === 'e2e-api-1' &&
          scenarioRequestIndex === 1
        ) {
          holdInteractionUntilReload(res, record);
          return;
        }

        if (scenario === 'fallback-four') {
          const expected =
            EXPECTED_FOUR_PROFILE_ORDER[scenarioRequestIndex - 1];
          const tupleMatches = Boolean(
            expected &&
            expected[0] === apiKey &&
            expected[1] === body?.model
          );

          if (!tupleMatches) {
            record.response = {
              status: 409,
              outcome: 'profile-order-mismatch',
              eventsSent: 0,
              closedEarly: false
            };
            sendJson(res, 409, {
              error: {
                code: 409,
                status: 'FAILED_PRECONDITION',
                message:
                  'Deterministic mock: unexpected key/model profile order.'
              }
            });
            return;
          }

          if (scenarioRequestIndex <= 3) {
            record.response = {
              status: 401,
              outcome: 'classified-profile-failure',
              eventsSent: 0,
              closedEarly: false
            };
            sendJson(res, 401, {
              error: {
                code: 401,
                status: 'UNAUTHENTICATED',
                message:
                  'Deterministic mock: classified profile failure; continue once.'
              }
            });
            return;
          }
        }

        if (
          scenario === 'sse-error-next-profile' ||
          scenario === 'terminal-failed-next-profile'
        ) {
          const expected = scenarioRequestIndex === 1
            ? ['e2e-api-1', MODEL]
            : scenarioRequestIndex === 2
              ? ['e2e-api-2', MODEL]
              : null;
          const tupleMatches = Boolean(
            expected &&
            expected[0] === apiKey &&
            expected[1] === body?.model
          );

          if (!tupleMatches) {
            record.response = {
              status: 409,
              outcome: 'unexpected-modality-continuation',
              eventsSent: 0,
              closedEarly: false
            };
            sendJson(res, 409, {
              error: {
                code: 409,
                status: 'FAILED_PRECONDITION',
                message:
                  'Deterministic mock: expected the next ordered tuple directly.'
              }
            });
            return;
          }

          if (scenarioRequestIndex === 1) {
            if (scenario === 'sse-error-next-profile') {
              sendSingleLineSseError(
                res,
                record,
                IMAGE_MODALITY_MESSAGE,
                'sse-error-modality'
              );
            } else {
              sendTerminalFailedCompletion(res, record);
            }
            return;
          }
        }

        if (scenario === 'thought-high-demand-four') {
          const expected =
            EXPECTED_THOUGHT_HIGH_DEMAND_ORDER[scenarioRequestIndex - 1];
          const tupleMatches = Boolean(
            expected &&
            expected[0] === apiKey &&
            expected[1] === body?.model
          );

          if (!tupleMatches) {
            record.response = {
              status: 409,
              outcome: 'unexpected-thought-demand-continuation',
              eventsSent: 0,
              closedEarly: false
            };
            sendJson(res, 409, {
              error: {
                code: 409,
                status: 'FAILED_PRECONDITION',
                message:
                  'Deterministic mock: expected API 1-4 on gemini-3.6-flash.'
              }
            });
            return;
          }

          if (scenarioRequestIndex <= 3) {
            streamThoughtThenHighDemand(
              res,
              record,
              scenarioRequestIndex % 2 === 0
                ? 'terminal-failed'
                : 'stream-error'
            );
            return;
          }
        }

        if (scenario === 'answer-high-demand-no-fallback') {
          const firstTuple =
            scenarioRequestIndex === 1 &&
            apiKey === 'e2e-api-1' &&
            body?.model === MODEL;

          if (!firstTuple) {
            record.response = {
              status: 409,
              outcome: 'unexpected-continuation-after-answer-demand',
              eventsSent: 0,
              closedEarly: false,
              thoughtOutput: false,
              answerOutput: false
            };
            sendJson(res, 409, {
              error: {
                code: 409,
                status: 'FAILED_PRECONDITION',
                message:
                  'Deterministic mock: high demand after answer output must not traverse profiles.'
              }
            });
            return;
          }

          streamThoughtThenHighDemand(
            res,
            record,
            'stream-error',
            true
          );
          return;
        }

        if (scenario === 'payload-error-no-fallback') {
          const firstTuple =
            scenarioRequestIndex === 1 &&
            apiKey === 'e2e-api-1' &&
            body?.model === MODEL;

          if (!firstTuple) {
            record.response = {
              status: 409,
              outcome: 'unexpected-payload-error-fallback',
              eventsSent: 0,
              closedEarly: false
            };
            sendJson(res, 409, {
              error: {
                code: 409,
                status: 'FAILED_PRECONDITION',
                message:
                  'Deterministic mock: payload errors must not traverse profiles.'
              }
            });
            return;
          }

          sendSingleLineSseError(
            res,
            record,
            UNSUPPORTED_IMAGE_PAYLOAD_MESSAGE,
            'payload-error'
          );
          return;
        }

        if (
          scenario === 'fallback-429' &&
          apiKey === 'e2e-api-1'
        ) {
          record.response = {
            status: 429,
            outcome: 'api1-429',
            eventsSent: 0,
            closedEarly: false
          };
          sendJson(res, 429, {
            error: {
              code: 429,
              status: 'RESOURCE_EXHAUSTED',
              message: 'Deterministic mock: API 1 quota exhausted.'
            }
          });
          return;
        }

        if (scenario === 'partial-no-continue') {
          if (scenarioRequestIndex === 1) {
            streamPartialThenDisconnect(res, record);
          } else {
            record.response = {
              status: 409,
              outcome: 'unexpected-continuation-after-partial',
              eventsSent: 0,
              closedEarly: false,
              partialOutput: false
            };
            sendJson(res, 409, {
              error: {
                code: 409,
                status: 'FAILED_PRECONDITION',
                message:
                  'Deterministic mock: partial output must stop all continuation.'
              }
            });
          }
          return;
        }

        if (body?.stream === false) {
          record.response = {
            status: 200,
            outcome: 'completed',
            eventsSent: 0,
            closedEarly: false
          };
          sendJson(
            res,
            200,
            completedInteraction('mock-sync-' + record.id)
          );
          return;
        }

        streamInteraction(res, record);
        return;
      }

      if (url.pathname === '/docs' || url.pathname === '/docs/') {
        await serveFile(res, path.join(DOCS_DIR, 'index.html'), {
          transform: buffer =>
            Buffer.from(injectHarness(buffer.toString('utf8')), 'utf8')
        });
        return;
      }

      if (url.pathname === '/docs/source.html') {
        await serveFile(
          res,
          path.join(WORKSPACE, 'src', 'math-app.html'),
          {
            transform: buffer =>
              Buffer.from(injectHarness(buffer.toString('utf8')), 'utf8')
          }
        );
        return;
      }

      if (url.pathname === '/__harness__/retry-after-reload-driver.js') {
        await serveFile(
          res,
          path.join(HERE, 'retry-after-reload-driver.js')
        );
        return;
      }

      if (url.pathname === '/docs/index.html') {
        await serveFile(res, path.join(DOCS_DIR, 'index.html'), {
          transform: buffer =>
            Buffer.from(injectHarness(buffer.toString('utf8')), 'utf8')
        });
        return;
      }

      if (url.pathname === '/docs/sw.js') {
        sendText(
          res,
          404,
          'Service worker disabled by deterministic E2E harness.'
        );
        return;
      }

      if (url.pathname.startsWith('/docs/')) {
        const file = safeFile(
          DOCS_DIR,
          url.pathname.slice('/docs/'.length)
        );
        if (!file) {
          sendText(res, 403, 'Forbidden.');
          return;
        }
        await serveFile(res, file);
        return;
      }

      if (url.pathname.startsWith('/tests/e2e/fixtures/')) {
        const file = safeFile(
          FIXTURES_DIR,
          url.pathname.slice('/tests/e2e/fixtures/'.length)
        );
        if (!file) {
          sendText(res, 403, 'Forbidden.');
          return;
        }
        await serveFile(res, file);
        return;
      }

      sendText(res, 404, 'Not found.');
    } catch (error) {
      const status = Number(error?.status) || 500;
      sendJson(res, status, {
        error: {
          message: error?.message || String(error)
        }
      });
    }
  });

  return {
    server,
    requestLog,
    clientEvidenceLog,
    evaluate: options => evaluateRequests(requestLog, {
      ...options,
      clientEvidenceLog
    })
  };
}

function cliOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : fallback;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const host = cliOption('--host', DEFAULT_HOST);
  const port = Number(cliOption('--port', String(DEFAULT_PORT)));
  const { server } = createHarnessServer();

  server.listen(port, host, () => {
    const address = server.address();
    const actualPort =
      typeof address === 'object' && address ? address.port : port;
    process.stdout.write(
      [
        'Math app E2E harness is ready.',
        'Dashboard: http://' + host + ':' + actualPort + '/__harness__/',
        'Success:   http://' + host + ':' + actualPort + '/docs/?scenario=success&fresh=1',
        'Slow/Stop: http://' + host + ':' + actualPort + '/docs/?scenario=slow&fresh=1',
        'Fallback:  http://' + host + ':' + actualPort + '/docs/?scenario=fallback-429&fresh=1',
        '4 profiles:http://' + host + ':' + actualPort + '/docs/?scenario=fallback-four&fresh=1',
        'Partial:   http://' + host + ':' + actualPort + '/docs/?scenario=partial-no-continue&fresh=1',
        'SSE error: http://' + host + ':' + actualPort + '/docs/?scenario=sse-error-next-profile&fresh=1',
        'Failed:    http://' + host + ':' + actualPort + '/docs/?scenario=terminal-failed-next-profile&fresh=1',
        'Demand:    http://' + host + ':' + actualPort + '/docs/?scenario=thought-high-demand-four&fresh=1',
        'Answer:    http://' + host + ':' + actualPort + '/docs/?scenario=answer-high-demand-no-fallback&fresh=1',
        'Payload:   http://' + host + ':' + actualPort + '/docs/?scenario=payload-error-no-fallback&fresh=1',
        'GW primary:http://' + host + ':' + actualPort + '/docs/source.html?scenario=gateway-success-local-unused&fresh=1',
        'GW marked: http://' + host + ':' + actualPort + '/docs/source.html?scenario=gateway-marked-upstream-no-local&fresh=1',
        'GW SSE err:http://' + host + ':' + actualPort + '/docs/source.html?scenario=gateway-sse-transport-error-no-fallback&fresh=1',
        'GW rate:   http://' + host + ':' + actualPort + '/docs/source.html?scenario=gateway-rate-control-local&fresh=1',
        'GW unmark: http://' + host + ':' + actualPort + '/docs/source.html?scenario=gateway-unmarked-deployment-local&fresh=1',
        'GW health: http://' + host + ':' + actualPort + '/docs/source.html?scenario=gateway-fetch-health-fail-local&fresh=1',
        'Local keys:http://' + host + ':' + actualPort + '/docs/source.html?scenario=local-key-fallback-order&fresh=1',
        'No locals: http://' + host + ':' + actualPort + '/docs/source.html?scenario=gateway-down-no-local-keys&fresh=1',
        'Retry:     http://' + host + ':' + actualPort + '/docs/?scenario=retry-after-reload&fresh=1&run=retry-' + Date.now(),
        'Fixture:   ' + path.join(FIXTURES_DIR, 'linear-equation.png'),
        ''
      ].join('\n')
    );
  });
}
