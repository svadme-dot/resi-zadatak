import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..', '..');
const DOCS_DIR = path.join(WORKSPACE, 'docs');
const FIXTURES_DIR = path.join(HERE, 'fixtures');
const GEMINI_ORIGIN =
  'https://generativelanguage.googleapis.com/v1beta/interactions';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const VALID_SCENARIOS = new Set([
  'success',
  'slow',
  'fallback-429',
  'background-reload',
  'background-stop',
  'viewer-disconnect',
  'rapid-double-send',
  'stop-before-create',
  'ambiguous-create',
  'cross-tab-create',
  'lease-fence-loss',
  'image-modality-error'
]);
const BACKGROUND_SCENARIOS = new Set([
  'background-reload',
  'background-stop',
  'viewer-disconnect',
  'rapid-double-send',
  'stop-before-create',
  'ambiguous-create',
  'cross-tab-create',
  'lease-fence-loss',
  'image-modality-error'
]);

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

function apiSlotForKey(value) {
  const match = /^e2e-api-(\d+)$/.exec(String(value || ''));
  return match ? Number(match[1]) : 0;
}

function findImagePart(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  return input.find(part => part?.type === 'image') || null;
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

function decodedImageMatchesMime(image) {
  if (!image || !isBase64(image.data)) return false;
  const bytes = Buffer.from(image.data, 'base64');
  const mime = String(image.mime_type || '').toLowerCase();
  if (mime === 'image/png') {
    return (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      )
    );
  }
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    return (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    );
  }
  return false;
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

function evaluateCreateRequest(record) {
  const body = record.body || {};
  const image = findImagePart(body);
  const forbidden = findForbiddenSearchConfig(body);
  const checks = {
    model:
      body.model === 'gemini-3.7-flash',
    thinkingLevel:
      body.generation_config?.thinking_level === 'high',
    thinkingSummaries:
      body.generation_config?.thinking_summaries === 'auto',
    toolsExactlyCodeExecution:
      Array.isArray(body.tools) &&
      body.tools.length === 1 &&
      Object.keys(body.tools[0] || {}).length === 1 &&
      body.tools[0]?.type === 'code_execution',
    noGoogleSearchOrGrounding:
      forbidden.length === 0,
    imagePayload:
      image?.mime_type?.startsWith('image/') === true &&
      isBase64(image?.data)
  };

  if (BACKGROUND_SCENARIOS.has(record.scenario)) {
    checks.backgroundEnabled = body.background === true;
    checks.storedForRecovery = body.store === true;
    checks.createReturnsInteractionResource = body.stream === false;
  }

  return {
    requestId: record.id,
    scenario: record.scenario,
    apiSlot: record.apiSlot,
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
  const clientLog = Array.isArray(options.clientLog) ? options.clientLog : [];
  const relevant = requestLog.filter(record =>
    !scenario || record.scenario === scenario
  );
  const relevantClients = clientLog.filter(record =>
    !scenario || record.scenario === scenario
  );
  const createRecords = relevant.filter(record => record.kind === 'create');
  const retrieveRecords = relevant.filter(record =>
    record.kind === 'retrieve-stream' ||
    record.kind === 'retrieve-canonical'
  );
  const cancelRecords = relevant.filter(record => record.kind === 'cancel');
  const requestAssertions = createRecords.map(evaluateCreateRequest);
  const transportChecks = {
    apiRevisionAbsent: relevant.every(
      record => !record.request?.apiRevision
    )
  };
  const scenarioChecks = {};

  if (scenario === 'success') {
    scenarioChecks.completedStream = relevant.some(
      record =>
        record.response?.outcome === 'completed' ||
        record.response?.terminalEventSent === true
    );
  }

  if (scenario === 'fallback-429') {
    const api1 = createRecords.filter(record => record.apiSlot === 1);
    const api2 = relevant.filter(record => record.apiSlot === 2);
    scenarioChecks.api1Returned429 =
      api1.length > 0 &&
      api1.every(record => record.response?.status === 429);
    scenarioChecks.api2Completed =
      api2.some(
        record =>
          record.response?.outcome === 'completed' ||
          record.response?.terminalEventSent === true
      );
    scenarioChecks.api1WasBeforeApi2 =
      api1.length > 0 &&
      api2.length > 0 &&
      Math.max(...api1.map(record => record.id)) <
        Math.min(...api2.map(record => record.id));
  }

  if (scenario === 'slow' && options.expectStop) {
    scenarioChecks.clientAbortedSlowStream = relevant.some(
      record =>
        record.response?.closedEarly === true &&
        record.response?.eventsSent > 0
    );
  }

  if (scenario === 'background-reload') {
    const streamRetrievals = retrieveRecords.filter(
      record => record.kind === 'retrieve-stream'
    );
    const canonicalRetrievals = retrieveRecords.filter(
      record => record.kind === 'retrieve-canonical'
    );
    const interactionIds = new Set(
      relevant.map(record => record.interactionId).filter(Boolean)
    );
    scenarioChecks.createdOnce = createRecords.length === 1;
    scenarioChecks.reconnectedSameInteraction =
      retrieveRecords.length >= 2 &&
      interactionIds.size === 1;
    scenarioChecks.firstViewerDisconnected = retrieveRecords.some(
      record => record.response?.outcome === 'client-aborted'
    );
    scenarioChecks.resumedWithLastEventIdOrCanonicalGet =
      streamRetrievals.slice(1).some(
        record => Boolean(record.request?.lastEventId)
      ) ||
      canonicalRetrievals.length > 0;
    scenarioChecks.sparseCompletionFollowedByCanonicalGet =
      streamRetrievals.some(
        record => record.response?.terminalEventSent === true
      ) &&
      canonicalRetrievals.some(
        record => record.response?.outcome === 'completed'
      );
    scenarioChecks.completedAfterReconnect = canonicalRetrievals.some(
      record => record.response?.outcome === 'completed'
    );
  }

  if (scenario === 'background-stop') {
    const firstCancel = cancelRecords[0];
    scenarioChecks.partialOutputBeforeCancel = retrieveRecords.some(
      record =>
        record.response?.partialOutputSent === true &&
        (!firstCancel || record.id < firstCancel.id)
    );
    scenarioChecks.cancelEndpointCalled =
      cancelRecords.length === 1 &&
      cancelRecords[0].response?.outcome === 'cancelled';
    scenarioChecks.cancelledInteractionRetained =
      cancelRecords[0]?.response?.interactionStatus === 'cancelled' &&
      cancelRecords[0]?.response?.partialOutputRetained === true;
    scenarioChecks.noApi2 =
      relevant.every(record => record.apiSlot !== 2);
  }

  if (scenario === 'viewer-disconnect') {
    const streamRetrievals = retrieveRecords.filter(
      record => record.kind === 'retrieve-stream'
    );
    const canonicalRetrievals = retrieveRecords.filter(
      record => record.kind === 'retrieve-canonical'
    );
    const interactionIds = new Set(
      relevant.map(record => record.interactionId).filter(Boolean)
    );
    scenarioChecks.createdOnce = createRecords.length === 1;
    scenarioChecks.viewerWasDisconnected = retrieveRecords.some(
      record => record.response?.outcome === 'viewer-disconnected'
    );
    scenarioChecks.reconnectedSameInteraction =
      retrieveRecords.length >= 2 &&
      interactionIds.size === 1;
    scenarioChecks.secondStreamUsedLastEventId =
      streamRetrievals.length >= 2 &&
      Boolean(streamRetrievals[1].request?.lastEventId);
    scenarioChecks.sparseCompletionFollowedByCanonicalGet =
      streamRetrievals.some(
        record => record.response?.terminalEventSent === true
      ) &&
      canonicalRetrievals.some(
        record => record.response?.outcome === 'completed'
      );
    scenarioChecks.completedAfterReconnect = canonicalRetrievals.some(
      record => record.response?.outcome === 'completed'
    );
    scenarioChecks.noApi2 =
      relevant.every(record => record.apiSlot !== 2);
  }

  if (scenario === 'rapid-double-send') {
    scenarioChecks.exactlyOneCreatePost = createRecords.length === 1;
    scenarioChecks.createResponseDelivered =
      createRecords[0]?.response?.outcome === 'background-created';
    scenarioChecks.noApi2 =
      relevant.every(record => record.apiSlot !== 2);
  }

  if (scenario === 'stop-before-create') {
    const created = createRecords[0];
    const cancelled = cancelRecords[0];
    scenarioChecks.exactlyOneCreatePost = createRecords.length === 1;
    scenarioChecks.createResponseWasNotAborted =
      created?.response?.outcome === 'background-created';
    scenarioChecks.cancelledReturnedInteraction =
      cancelRecords.length === 1 &&
      cancelled?.interactionId === created?.interactionId &&
      cancelled?.response?.interactionStatus === 'cancelled';
    scenarioChecks.noOrphanOrSecondCreate =
      createRecords.length === 1 &&
      cancelRecords.length === 1;
    scenarioChecks.noApi2 =
      relevant.every(record => record.apiSlot !== 2);
  }

  if (scenario === 'ambiguous-create') {
    const accepted = createRecords[0];
    scenarioChecks.exactlyOneCreatePost = createRecords.length === 1;
    scenarioChecks.serverAcceptedButResponseWasLost =
      accepted?.response?.accepted === true &&
      accepted?.response?.outcome === 'transport-dropped-after-accept';
    scenarioChecks.noAutomaticRetryOrApi2 =
      createRecords.length === 1 &&
      relevant.every(record => record.apiSlot !== 2);
    scenarioChecks.noFollowupWithoutInteractionId =
      retrieveRecords.length === 0 &&
      cancelRecords.length === 0;
  }

  if (scenario === 'cross-tab-create') {
    const loadedTabs = new Set(
      relevantClients
        .filter(record => record.event === 'loaded')
        .map(record => record.tabId)
        .filter(Boolean)
    );
    const requestTabs = new Set(
      relevant.map(record => record.tabId).filter(Boolean)
    );
    const finalCanonical = retrieveRecords.filter(
      record =>
        record.kind === 'retrieve-canonical' &&
        record.response?.outcome === 'completed'
    );
    scenarioChecks.twoTabsLoaded = loadedTabs.size >= 2;
    scenarioChecks.exactlyOneCreatePost = createRecords.length === 1;
    scenarioChecks.onlyLeaseOwnerUsedGemini = requestTabs.size === 1;
    scenarioChecks.singleFinalizer =
      finalCanonical.length === 1 &&
      new Set(finalCanonical.map(record => record.tabId).filter(Boolean)).size === 1;
    scenarioChecks.noApi2 =
      relevant.every(record => record.apiSlot !== 2);
  }

  if (scenario === 'lease-fence-loss') {
    const loadedTabs = new Set(
      relevantClients
        .filter(record => record.event === 'loaded')
        .map(record => record.tabId)
        .filter(Boolean)
    );
    const fenceEvent = relevantClients.find(
      record => record.event === 'forced-fence-loss'
    );
    const createTab = createRecords[0]?.tabId || '';
    const losingTabStreams = retrieveRecords.filter(
      record =>
        record.kind === 'retrieve-stream' &&
        record.tabId === createTab
    );
    const losingTabFinals = retrieveRecords.filter(
      record =>
        record.kind === 'retrieve-canonical' &&
        record.tabId === createTab &&
        record.response?.outcome === 'completed'
    );
    scenarioChecks.twoTabsLoaded = loadedTabs.size >= 2;
    scenarioChecks.exactlyOneCreatePost = createRecords.length === 1;
    scenarioChecks.fenceWasChangedByOtherTab =
      Boolean(fenceEvent?.tabId) &&
      Boolean(createTab) &&
      fenceEvent.tabId !== createTab;
    scenarioChecks.losingViewerStoppedBeforeTerminal =
      losingTabStreams.some(
        record =>
          record.response?.outcome === 'client-aborted' &&
          record.response?.terminalEventSent !== true
      );
    scenarioChecks.losingTabDidNotFinalize = losingTabFinals.length === 0;
    scenarioChecks.noSecondCreateOrApi2 =
      createRecords.length === 1 &&
      relevant.every(record => record.apiSlot !== 2);
  }

  if (scenario === 'image-modality-error') {
    const create = createRecords[0];
    const image = findImagePart(create?.body);
    const terminalGet = retrieveRecords.find(
      record =>
        record.kind === 'retrieve-canonical' &&
        record.response?.outcome === 'failed'
    );
    const uiClassification = relevantClients.find(
      record => record.event === 'terminal-classification'
    );
    scenarioChecks.exactlyOneBackgroundCreate = createRecords.length === 1;
    scenarioChecks.publicFlashModelNotAgent =
      create?.body?.model === 'gemini-3.7-flash' &&
      !String(create?.body?.model || '').includes('-agent');
    scenarioChecks.rasterBytesMatchDeclaredMime =
      decodedImageMatchesMime(image);
    scenarioChecks.googleErrorsArrayWasCanonicalFailure =
      terminalGet?.response?.interactionStatus === 'failed' &&
      terminalGet?.response?.terminalErrors?.some(error =>
        /Image input modality is not enabled for models\/gemini-3\.7-flash-agent/i.test(
          String(error?.message || '')
        )
      );
    scenarioChecks.appClassifiedFailureAsInterrupted =
      uiClassification?.detail?.completionState === 'interrupted';
    scenarioChecks.errorMessageSurfaced =
      uiClassification?.detail?.errorSurfaced === true;
    scenarioChecks.notUserStop =
      Boolean(uiClassification) &&
      uiClassification?.detail?.completionState !== 'stopped' &&
      cancelRecords.length === 0;
    scenarioChecks.noApi2 =
      relevant.every(record => record.apiSlot !== 2);
  }

  const hasSolverRequest = createRecords.length > 0;
  const requestsOk =
    hasSolverRequest &&
    requestAssertions.every(assertion => assertion.ok) &&
    Object.values(transportChecks).every(Boolean);
  const scenarioOk =
    Object.values(scenarioChecks).every(Boolean);

  return {
    ok: requestsOk && scenarioOk,
    filters: {
      scenario: scenario || null,
      expectStop: Boolean(options.expectStop)
    },
    counts: {
      allMatchingRequests: relevant.length,
      createRequests: createRecords.length,
      retrieveRequests: retrieveRecords.length,
      cancelRequests: cancelRecords.length,
      createRequestsWithImage: createRecords.filter(record =>
        Boolean(findImagePart(record.body))
      ).length,
      loadedClientTabs: new Set(
        relevantClients.map(record => record.tabId).filter(Boolean)
      ).size
    },
    scenarioChecks,
    transportChecks,
    requests: requestAssertions
  };
}

function completedInteraction(id) {
  return {
    id,
    model: 'gemini-3.7-flash',
    object: 'interaction',
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

function partialInteraction(id, status = 'in_progress') {
  return {
    id,
    model: 'gemini-3.7-flash',
    object: 'interaction',
    status,
    steps: [
      {
        type: 'thought',
        summary: [
          {
            type: 'text',
            text: 'Prepoznajem linearnu jednačinu i proveravam prvi korak.'
          }
        ]
      },
      {
        type: 'model_output',
        content: [
          {
            type: 'text',
            text: 'Oduzmemo 3 sa obe strane.\n\n\\[2x=8\\]'
          }
        ]
      }
    ]
  };
}

function sparseInteraction(id, status) {
  return {
    id,
    model: 'gemini-3.7-flash',
    object: 'interaction',
    status
  };
}

function failedImageModalityInteraction(id) {
  return {
    id,
    model: 'gemini-3.7-flash',
    object: 'interaction',
    status: 'failed',
    errors: [
      {
        code: 400,
        message:
          'Image input modality is not enabled for models/gemini-3.7-flash-agent'
      }
    ]
  };
}

function backgroundEventId(job, ordinal) {
  return job.id + '-event-' + String(ordinal).padStart(3, '0');
}

function backgroundEvents(job) {
  if (job.scenario === 'image-modality-error') {
    return [
      {
        event_id: backgroundEventId(job, 1),
        event_type: 'interaction.created',
        interaction: sparseInteraction(job.id, 'in_progress')
      },
      {
        event_id: backgroundEventId(job, 2),
        event_type: 'interaction.completed',
        // Intentionally sparse: the app must canonical-GET errors[].
        interaction: sparseInteraction(job.id, 'failed')
      }
    ];
  }

  return [
    {
      event_id: backgroundEventId(job, 1),
      event_type: 'interaction.created',
      interaction: sparseInteraction(job.id, 'in_progress')
    },
    {
      event_id: backgroundEventId(job, 2),
      event_type: 'step.start',
      index: 0,
      step: { type: 'thought' }
    },
    {
      event_id: backgroundEventId(job, 3),
      event_type: 'step.delta',
      index: 0,
      delta: {
        type: 'thought_summary',
        content: [
          {
            type: 'text',
            text: 'Prepoznajem linearnu jednačinu i izdvajam nepoznatu. '
          }
        ]
      }
    },
    {
      event_id: backgroundEventId(job, 4),
      event_type: 'step.start',
      index: 1,
      step: { type: 'model_output' }
    },
    {
      event_id: backgroundEventId(job, 5),
      event_type: 'step.delta',
      index: 1,
      delta: {
        type: 'text',
        text: 'Oduzmemo 3 sa obe strane.\n\n\\[2x=8\\]\n\n'
      }
    },
    {
      event_id: backgroundEventId(job, 6),
      event_type: 'step.delta',
      index: 1,
      delta: {
        type: 'text',
        text: 'Podelimo sa 2:\n\n\\[x=4\\]\n\n**Odgovor:** \\(x=4\\).'
      }
    },
    {
      event_id: backgroundEventId(job, 7),
      event_type: 'interaction.completed',
      interaction: sparseInteraction(job.id, 'completed')
    }
  ];
}

function ssePlan(scenario, interactionId) {
  const completed = {
    event_type: 'interaction.completed',
    interaction: sparseInteraction(interactionId, 'completed')
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

function closeActiveViewer(entry, outcome) {
  for (const timer of entry.timers) clearTimeout(timer);
  entry.timers.clear();
  if (!entry.res.destroyed && !entry.res.writableEnded) {
    entry.record.response.outcome = outcome;
    entry.res.end();
  }
}

function sendBackgroundCreated(res, record, job, delayMs = 0) {
  record.response = {
    status: 200,
    outcome: delayMs > 0 ? 'create-response-pending' : 'background-created',
    interactionId: job.id,
    interactionStatus: 'in_progress',
    delayedByMs: delayMs,
    eventsSent: 0,
    closedEarly: false
  };

  const deliver = () => {
    job.createTimer = null;
    if (res.destroyed || res.writableEnded) {
      record.response.closedEarly = true;
      record.response.outcome = 'create-response-client-aborted';
      job.orphanedByViewerAbort = true;
      return;
    }

    record.response.outcome = 'background-created';
    record.response.deliveredAt = new Date().toISOString();
    sendJson(res, 200, sparseInteraction(job.id, 'in_progress'));
  };

  res.once('close', () => {
    if (!res.writableEnded && record.response.outcome === 'create-response-pending') {
      record.response.closedEarly = true;
      record.response.outcome = 'create-response-client-aborted';
      job.orphanedByViewerAbort = true;
    }
  });

  if (delayMs > 0) {
    job.createTimer = setTimeout(deliver, delayMs);
  } else {
    deliver();
  }
}

function dropAmbiguousCreateResponse(res, record, job, delayMs = 180) {
  record.response = {
    status: 0,
    outcome: 'accepted-awaiting-transport-drop',
    accepted: true,
    interactionId: job.id,
    interactionStatus: 'in_progress',
    delayedByMs: delayMs,
    eventsSent: 0,
    closedEarly: false
  };

  job.createTimer = setTimeout(() => {
    job.createTimer = null;
    record.response.outcome = 'transport-dropped-after-accept';
    record.response.closedEarly = true;
    record.response.droppedAt = new Date().toISOString();
    if (!res.destroyed) res.destroy();
  }, delayMs);
}

function cancelBackgroundJob(job) {
  job.status = 'cancelled';
  job.cancelledAt = new Date().toISOString();

  for (const entry of [...job.activeViewers]) {
    for (const timer of entry.timers) clearTimeout(timer);
    entry.timers.clear();

    if (!entry.res.destroyed && !entry.res.writableEnded) {
      const event = {
        event_id: backgroundEventId(job, 8),
        event_type: 'interaction.completed',
        interaction: sparseInteraction(job.id, 'cancelled')
      };
      entry.res.write('data: ' + JSON.stringify(event) + '\n\n');
      entry.record.response.eventsSent += 1;
      entry.record.response.eventIdsSent.push(event.event_id);
      entry.record.response.outcome = 'cancelled';
      entry.record.response.interactionStatus = 'cancelled';
      entry.record.response.partialOutputRetained = job.partialDelivered;
      entry.res.end();
    }
  }
}

function streamBackgroundInteraction(res, record, job) {
  const events = backgroundEvents(job);
  const lastEventId = record.request.lastEventId || '';
  let startIndex = 0;

  if (lastEventId) {
    const previousIndex = events.findIndex(
      event => event.event_id === lastEventId
    );
    if (previousIndex < 0) {
      record.response = {
        status: 400,
        outcome: 'unknown-last-event-id',
        eventsSent: 0,
        closedEarly: false
      };
      sendJson(res, 400, {
        error: {
          message: 'Unknown deterministic last_event_id.'
        }
      });
      return;
    }
    startIndex = previousIndex + 1;
  }

  const viewerNumber = job.streamConnections + 1;
  job.streamConnections = viewerNumber;

  let mode = 'complete';
  if (
    job.scenario === 'viewer-disconnect' &&
    viewerNumber === 1 &&
    !lastEventId
  ) {
    mode = 'disconnect';
  } else if (
    job.scenario === 'background-reload' &&
    viewerNumber === 1 &&
    !lastEventId
  ) {
    mode = 'hold';
  } else if (
    job.scenario === 'background-stop' ||
    job.scenario === 'slow' ||
    job.scenario === 'lease-fence-loss'
  ) {
    mode = 'hold';
  }

  const partialIndex = events.findIndex(
    event =>
      event.event_type === 'step.delta' &&
      event.index === 1 &&
      event.delta?.type === 'text'
  );
  const endIndex =
    mode === 'complete'
      ? events.length - 1
      : Math.max(startIndex, partialIndex);
  const selected = events.slice(startIndex, endIndex + 1);

  record.response = {
    status: 200,
    outcome: 'streaming',
    eventsSent: 0,
    eventIdsSent: [],
    lastEventIdSent: '',
    partialOutputSent: false,
    terminalEventSent: false,
    closedAfterTerminal: false,
    closedEarly: false,
    viewerNumber,
    resumed: Boolean(lastEventId)
  };

  res.writeHead(200, {
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write(': deterministic background interaction stream\n\n');

  const entry = {
    res,
    record,
    timers: new Set()
  };
  job.activeViewers.add(entry);

  const cleanup = () => {
    for (const timer of entry.timers) clearTimeout(timer);
    entry.timers.clear();
    job.activeViewers.delete(entry);
  };

  res.once('close', () => {
    if (
      !res.writableEnded &&
      record.response.outcome !== 'viewer-disconnected'
    ) {
      if (record.response.terminalEventSent) {
        // The app intentionally cancels its SSE reader as soon as the sparse
        // terminal event arrives, then canonical-GETs the stored resource.
        // That is a successful handoff, not a viewer failure.
        record.response.closedAfterTerminal = true;
        record.response.closedEarly = false;
        record.response.outcome =
          record.response.interactionStatus === 'completed'
            ? 'completed-sparse'
            : record.response.interactionStatus + '-sparse';
      } else {
        record.response.closedEarly = true;
        record.response.outcome = 'client-aborted';
      }
    }
    cleanup();
  });

  const finish = () => {
    if (mode === 'disconnect') {
      record.response.closedEarly = true;
      record.response.outcome = 'viewer-disconnected';
      const timer = setTimeout(() => {
        entry.timers.delete(timer);
        if (!res.destroyed) res.destroy();
      }, 25);
      entry.timers.add(timer);
      return;
    }

    if (mode === 'hold') {
      record.response.outcome = 'holding-partial';
      return;
    }

    const terminalStatus = record.response.terminalEventSent
      ? String(record.response.interactionStatus || 'completed')
      : 'completed';
    job.status = terminalStatus;
    job.completedAt = new Date().toISOString();
    record.response.outcome = terminalStatus;
    record.response.interactionStatus = terminalStatus;
    res.write('data: [DONE]\n\n');
    res.end();
  };

  const emit = index => {
    if (res.destroyed || res.writableEnded) return;
    if (index >= selected.length) {
      finish();
      return;
    }

    const event = selected[index];
    res.write('data: ' + JSON.stringify(event) + '\n\n');
    record.response.eventsSent += 1;
    record.response.eventIdsSent.push(event.event_id);
    record.response.lastEventIdSent = event.event_id;

    if (event.event_type === 'interaction.completed') {
      const terminalStatus = String(event.interaction?.status || 'completed');
      record.response.terminalEventSent = true;
      record.response.interactionStatus = terminalStatus;
      record.response.outcome =
        terminalStatus === 'completed'
          ? 'completed-sparse'
          : terminalStatus + '-sparse';
      job.status = terminalStatus;
      job.completedAt = new Date().toISOString();
    }

    if (
      event.event_type === 'step.delta' &&
      event.index === 1 &&
      event.delta?.type === 'text'
    ) {
      job.partialDelivered = true;
      record.response.partialOutputSent = true;
    }

    const timer = setTimeout(() => {
      entry.timers.delete(timer);
      emit(index + 1);
    }, index === 0 ? 20 : 55);
    entry.timers.add(timer);
  };

  emit(0);
}

function harnessBootstrap() {
  const lines = [
    '<script id="math-e2e-bootstrap">',
    '(function () {',
    '  var params = new URLSearchParams(location.search);',
    '  var allowed = [',
    '    "success", "slow", "fallback-429",',
    '    "background-reload", "background-stop", "viewer-disconnect",',
    '    "rapid-double-send", "stop-before-create", "ambiguous-create",',
    '    "cross-tab-create", "lease-fence-loss", "image-modality-error"',
    '  ];',
    '  var scenario = params.get("scenario") || "success";',
    '  if (allowed.indexOf(scenario) === -1) scenario = "success";',
    '  var runId = params.get("run") || scenario;',
    '  var tabId = "e2e-tab-" + (',
    '    window.crypto && crypto.randomUUID',
    '      ? crypto.randomUUID()',
    '      : Date.now() + "-" + Math.random().toString(36).slice(2)',
    '  );',
    '  var freshKey = "__math_e2e_fresh__:" + runId;',
    '  if (',
    '    params.get("fresh") !== "0" &&',
    '    sessionStorage.getItem(freshKey) !== "1"',
    '  ) {',
    '    localStorage.clear();',
    '    sessionStorage.setItem(freshKey, "1");',
    '  }',
    '  var profiles = [',
    '    { key: "e2e-api-1", model: "gemini-3.7-flash" },',
    '    (scenario === "fallback-429" || scenario === "ambiguous-create")',
    '      ? { key: "e2e-api-2", model: "gemini-3.7-flash" }',
    '      : { key: "", model: "gemini-3.7-flash" },',
    '    { key: "", model: "gemini-3.7-flash" },',
    '    { key: "", model: "gemini-3.7-flash" }',
    '  ];',
    '  localStorage.setItem(',
    '    "matematika_google_api_profiles_v1",',
    '    JSON.stringify(profiles)',
    '  );',
    '  localStorage.setItem("gemini_api_key_persistent_v1", "e2e-api-1");',
    '  var realFetch = window.fetch.bind(window);',
    '  function markClient(eventName, detail) {',
    '    return realFetch("/__harness__/client", {',
    '      method: "POST",',
    '      headers: { "Content-Type": "application/json" },',
    '      body: JSON.stringify({',
    '        scenario: scenario, run: runId, tabId: tabId,',
    '        event: String(eventName || "event"), detail: detail || null',
    '      })',
    '    }).catch(function () {});',
    '  }',
    '  function forceFenceLoss() {',
    '    var key = "matematika_background_global_lease_v2";',
    '    var current = {};',
    '    try { current = JSON.parse(localStorage.getItem(key) || "{}"); } catch (_) {}',
    '    var stolen = {',
    '      ownerTabId: "e2e-forced-owner-" + tabId,',
    '      localJobId: String(current.localJobId || ""),',
    '      fenceToken: "e2e-stolen-" + Date.now() + "-" + Math.random().toString(36).slice(2),',
    '      epoch: Number(current.epoch || 0) + 1,',
    '      expiresAt: Date.now() + 60000',
    '    };',
    '    localStorage.setItem(key, JSON.stringify(stolen));',
    '    markClient("forced-fence-loss", { epoch: stolen.epoch });',
    '    return stolen;',
    '  }',
    '  window.fetch = function (input, init) {',
    '    var raw = typeof input === "string"',
    '      ? input',
    '      : input && input.url ? input.url : String(input || "");',
    '    if (raw.indexOf(' + JSON.stringify(GEMINI_ORIGIN) + ') === 0) {',
    '      var original = new URL(raw);',
    '      var suffix = original.pathname.slice(',
    '        new URL(' + JSON.stringify(GEMINI_ORIGIN) + ').pathname.length',
    '      );',
    '      var mock = new URL(',
    '        "/__mock/gemini/v1beta/interactions" + suffix,',
    '        location.origin',
    '      );',
    '      original.searchParams.forEach(function (value, key) {',
    '        mock.searchParams.append(key, value);',
    '      });',
    '      mock.searchParams.set("scenario", scenario);',
    '      mock.searchParams.set("run", runId);',
    '      mock.searchParams.set("e2e_tab", tabId);',
    '      if (typeof Request !== "undefined" && input instanceof Request) {',
    '        input = new Request(mock.href, input);',
    '      } else {',
    '        input = mock.href;',
    '      }',
    '    }',
    '    return realFetch(input, init);',
    '  };',
    '  window.__MATH_E2E__ = {',
    '    scenario: scenario,',
    '    runId: runId,',
    '    tabId: tabId,',
    '    markClient: markClient,',
    '    forceFenceLoss: forceFenceLoss,',
    '    requests: "/__harness__/requests?scenario=" + encodeURIComponent(scenario),',
    '    assertions: "/__harness__/assertions?scenario=" + encodeURIComponent(scenario)',
    '  };',
    '  markClient("loaded", { fresh: params.get("fresh") !== "0" });',
    '  if (scenario === "image-modality-error") {',
    '    var terminalPolls = 0;',
    '    var terminalTimer = setInterval(function () {',
    '      terminalPolls += 1;',
    '      var chats = [];',
    '      try {',
    '        chats = JSON.parse(localStorage.getItem("gemini_mobile_chats_v1") || "[]");',
    '      } catch (_) {}',
    '      var models = [];',
    '      chats.forEach(function (chat) {',
    '        (Array.isArray(chat && chat.messages) ? chat.messages : []).forEach(function (message) {',
    '          if (message && message.role === "model") models.push(message);',
    '        });',
    '      });',
    '      var terminal = models.slice().reverse().find(function (message) {',
    '        return ["completed", "stopped", "interrupted"].indexOf(message.completionState) !== -1;',
    '      });',
    '      if (terminal) {',
    '        clearInterval(terminalTimer);',
    '        markClient("terminal-classification", {',
    '          completionState: String(terminal.completionState || ""),',
    '          errorSurfaced: /Image input modality is not enabled/i.test(String(terminal.text || ""))',
    '        });',
    '      } else if (terminalPolls >= 300) {',
    '        clearInterval(terminalTimer);',
    '        markClient("terminal-classification-timeout", null);',
    '      }',
    '    }, 100);',
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

function injectServiceWorkerHarness(serviceWorkerSource) {
  const anchor = '  const url = new URL(request.url);';
  if (!serviceWorkerSource.includes(anchor)) {
    throw new Error('Cannot inject the E2E service-worker bypass.');
  }
  return serviceWorkerSource.replace(
    anchor,
    [
      anchor,
      '',
      '  // math-e2e-sw-bypass: mock/evidence routes model Google network I/O.',
      '  // Let the browser fetch them directly; never cache or replay SSE/GETs.',
      '  if (url.origin === self.location.origin && (',
      '    url.pathname.startsWith("/__mock/") ||',
      '    url.pathname.startsWith("/__harness__/")',
      '  )) return;'
    ].join('\n')
  );
}

function dashboardHtml(host, port) {
  const base = 'http://' + host + ':' + port;
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
    '<li><a href="' + base + '/docs/?scenario=background-reload&fresh=1">Background create, reload, and reconnect</a></li>',
    '<li><a href="' + base + '/docs/?scenario=background-stop&fresh=1">Background partial output, then Stop/cancel</a></li>',
    '<li><a href="' + base + '/docs/?scenario=viewer-disconnect&fresh=1">Forced viewer disconnect, same-job reconnect</a></li>',
    '<li><a href="' + base + '/docs/?scenario=rapid-double-send&fresh=1">Delayed create for rapid double-send</a></li>',
    '<li><a href="' + base + '/docs/?scenario=stop-before-create&fresh=1">Stop before delayed create returns its ID</a></li>',
    '<li><a href="' + base + '/docs/?scenario=ambiguous-create&run=ambiguous-shared&fresh=1">Accepted create with lost transport outcome</a></li>',
    '<li>Cross-tab create gate: <a href="' + base + '/docs/?scenario=cross-tab-create&run=cross-tab-shared&fresh=1">open tab A first</a>, then <a href="' + base + '/docs/?scenario=cross-tab-create&run=cross-tab-shared&fresh=0" target="_blank">open tab B</a></li>',
    '<li>Fence loss: <a href="' + base + '/docs/?scenario=lease-fence-loss&run=fence-shared&fresh=1">open owner tab first</a>, then <a href="' + base + '/docs/?scenario=lease-fence-loss&run=fence-shared&fresh=0" target="_blank">open takeover tab</a></li>',
    '<li><a href="' + base + '/docs/?scenario=image-modality-error&run=image-modality-error&fresh=1">PNG create, then Google image-modality terminal error</a></li>',
    '</ul></div>',
    '<div class="card"><h2>Evidence</h2><ul>',
    '<li><a href="/__harness__/requests">Recorded request JSON</a></li>',
    '<li><a href="/__harness__/clients">Loaded-tab and fence-event JSON</a></li>',
    '<li><a href="/__harness__/jobs">Background job state</a></li>',
    '<li><a href="/__harness__/assertions">All request assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=success">Success assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=fallback-429">Fallback assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=slow&expectStop=1">Stop/abort assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=background-reload">Reload/reconnect assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=background-stop">Stop/cancel assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=viewer-disconnect">Viewer-disconnect assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=rapid-double-send">Rapid-double-send assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=stop-before-create">Early-Stop assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=ambiguous-create">Ambiguous-create assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=cross-tab-create">Cross-tab create-gate assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=lease-fence-loss">Fence-loss assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=image-modality-error">Image-modality error assertions</a></li>',
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
  const clientLog = [];
  const jobs = new Map();
  let nextRequestId = 1;
  let nextClientEventId = 1;
  let nextJobId = 1;

  const recordRequest = (
    req,
    url,
    kind,
    body = {},
    interactionId = ''
  ) => {
    const record = {
      id: nextRequestId++,
      receivedAt: new Date().toISOString(),
      run: url.searchParams.get('run') || '',
      scenario: scenarioFrom(url),
      tabId: url.searchParams.get('e2e_tab') || '',
      kind,
      interactionId,
      apiSlot: apiSlotForKey(req.headers['x-goog-api-key']),
      request: {
        method: req.method,
        path: url.pathname,
        alt: url.searchParams.get('alt') || '',
        stream: url.searchParams.get('stream') || '',
        lastEventId: url.searchParams.get('last_event_id') || '',
        accept: String(req.headers.accept || ''),
        contentType: String(req.headers['content-type'] || ''),
        apiRevision: String(req.headers['api-revision'] || '')
      },
      body,
      response: null
    };
    requestLog.push(record);
    return record;
  };

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
        for (const job of jobs.values()) {
          if (job.createTimer) clearTimeout(job.createTimer);
          for (const entry of [...job.activeViewers]) {
            closeActiveViewer(entry, 'harness-reset');
          }
        }
        jobs.clear();
        requestLog.length = 0;
        clientLog.length = 0;
        nextRequestId = 1;
        nextClientEventId = 1;
        nextJobId = 1;
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
        const records = requestLog.filter(record =>
          !requestedScenario || record.scenario === requestedScenario
        );
        sendJson(res, 200, { count: records.length, requests: records });
        return;
      }

      if (url.pathname === '/__harness__/client') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: { message: 'POST required.' } });
          return;
        }
        const body = await readJsonBody(req);
        const requestedScenario = String(body.scenario || 'success');
        const scenario = VALID_SCENARIOS.has(requestedScenario)
          ? requestedScenario
          : 'success';
        const record = {
          id: nextClientEventId++,
          receivedAt: new Date().toISOString(),
          scenario,
          run: String(body.run || '').slice(0, 120),
          tabId: String(body.tabId || '').slice(0, 160),
          event: String(body.event || 'event').slice(0, 80),
          detail:
            body.detail && typeof body.detail === 'object'
              ? body.detail
              : null
        };
        clientLog.push(record);
        sendJson(res, 200, { ok: true, id: record.id });
        return;
      }

      if (url.pathname === '/__harness__/clients') {
        const requestedScenario = url.searchParams.get('scenario') || '';
        const records = clientLog.filter(record =>
          !requestedScenario || record.scenario === requestedScenario
        );
        sendJson(res, 200, { count: records.length, clients: records });
        return;
      }

      if (url.pathname === '/__harness__/jobs') {
        sendJson(
          res,
          200,
          {
            count: jobs.size,
            jobs: [...jobs.values()].map(job => ({
              id: job.id,
              scenario: job.scenario,
              apiSlot: job.apiSlot,
              status: job.status,
              createdAt: job.createdAt,
              completedAt: job.completedAt,
              cancelledAt: job.cancelledAt,
              streamConnections: job.streamConnections,
              canonicalGets: job.canonicalGets,
              partialDelivered: job.partialDelivered,
              orphanedByViewerAbort: job.orphanedByViewerAbort,
              activeViewerCount: job.activeViewers.size
            }))
          }
        );
        return;
      }

      if (url.pathname === '/__harness__/assertions') {
        sendJson(
          res,
          200,
          evaluateRequests(requestLog, {
            scenario: url.searchParams.get('scenario') || '',
            expectStop: url.searchParams.get('expectStop') === '1',
            clientLog
          })
        );
        return;
      }

      if (url.pathname === '/__mock/gemini/v1beta/interactions') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: { message: 'POST required.' } });
          return;
        }

        const body = await readJsonBody(req);
        const scenario = scenarioFrom(url);
        const apiSlot = apiSlotForKey(req.headers['x-goog-api-key']);
        const record = recordRequest(req, url, 'create', body);

        if (
          scenario === 'fallback-429' &&
          apiSlot === 1
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

        if (body?.background === true) {
          const runLabel = String(record.run || scenario)
            .replace(/[^A-Za-z0-9_-]/g, '-')
            .slice(0, 40);
          const interactionId =
            'mock-bg-' +
            runLabel +
            '-' +
            String(nextJobId++).padStart(3, '0');
          const job = {
            id: interactionId,
            scenario,
            apiSlot,
            status: 'in_progress',
            createdAt: new Date().toISOString(),
            completedAt: '',
            cancelledAt: '',
            streamConnections: 0,
            canonicalGets: 0,
            partialDelivered: false,
            orphanedByViewerAbort: false,
            createTimer: null,
            activeViewers: new Set()
          };
          jobs.set(interactionId, job);
          record.interactionId = interactionId;

          if (scenario === 'ambiguous-create') {
            // The server has accepted and created the job, but the connection
            // disappears before any status line or interaction ID reaches the
            // browser. Retrying automatically would risk an orphan duplicate.
            dropAmbiguousCreateResponse(res, record, job);
            return;
          }

          if (body.stream === true) {
            streamBackgroundInteraction(res, record, job);
          } else {
            const createDelay =
              scenario === 'rapid-double-send' ||
              scenario === 'stop-before-create' ||
              scenario === 'cross-tab-create'
                ? 700
                : 0;
            sendBackgroundCreated(
              res,
              record,
              job,
              createDelay
            );
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

      const interactionMatch = url.pathname.match(
        /^\/__mock\/gemini\/v1beta\/interactions\/([^/]+)(\/cancel)?$/
      );

      if (interactionMatch) {
        const interactionId = decodeURIComponent(interactionMatch[1]);
        const isCancel = Boolean(interactionMatch[2]);
        const job = jobs.get(interactionId);

        if (!job) {
          sendJson(res, 404, {
            error: {
              message: 'Unknown deterministic interaction ID.'
            }
          });
          return;
        }

        if (isCancel) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: { message: 'POST required.' } });
            return;
          }

          const body = await readJsonBody(req);
          const record = recordRequest(
            req,
            url,
            'cancel',
            body,
            interactionId
          );
          cancelBackgroundJob(job);
          const cancelled = partialInteraction(interactionId, 'cancelled');
          record.response = {
            status: 200,
            outcome: 'cancelled',
            interactionStatus: 'cancelled',
            partialOutputRetained: job.partialDelivered,
            eventsSent: 0,
            closedEarly: false
          };
          sendJson(res, 200, cancelled);
          return;
        }

        if (req.method !== 'GET') {
          sendJson(res, 405, { error: { message: 'GET required.' } });
          return;
        }

        const wantsStream =
          url.searchParams.get('stream') === 'true' ||
          String(req.headers.accept || '').includes('text/event-stream');
        const record = recordRequest(
          req,
          url,
          wantsStream ? 'retrieve-stream' : 'retrieve-canonical',
          {},
          interactionId
        );

        if (wantsStream) {
          streamBackgroundInteraction(res, record, job);
          return;
        }

        job.canonicalGets += 1;
        let interaction;

        if (job.status === 'cancelled') {
          interaction = partialInteraction(interactionId, 'cancelled');
        } else if (
          job.status === 'failed' &&
          job.scenario === 'image-modality-error'
        ) {
          interaction = failedImageModalityInteraction(interactionId);
        } else if (job.status === 'completed') {
          interaction = completedInteraction(interactionId);
        } else if (
          job.scenario !== 'background-stop' &&
          (
            job.partialDelivered ||
            job.scenario === 'success' ||
            job.scenario === 'fallback-429' ||
            job.canonicalGets >= 2
          )
        ) {
          job.status = 'completed';
          job.completedAt = new Date().toISOString();
          interaction = completedInteraction(interactionId);
        } else {
          interaction = job.partialDelivered
            ? partialInteraction(interactionId, 'in_progress')
            : sparseInteraction(interactionId, 'in_progress');
        }

        record.response = {
          status: 200,
          outcome:
            interaction.status === 'completed'
              ? 'completed'
              : interaction.status === 'cancelled'
                ? 'cancelled'
                : interaction.status === 'failed'
                  ? 'failed'
                  : 'in-progress',
          interactionStatus: interaction.status,
          partialOutputRetained:
            job.partialDelivered &&
            Array.isArray(interaction.steps),
          terminalErrors: Array.isArray(interaction.errors)
            ? interaction.errors.map(error => ({
                code: Number(error?.code || 0),
                message: String(error?.message || '')
              }))
            : [],
          eventsSent: 0,
          closedEarly: false
        };
        sendJson(res, 200, interaction);
        return;
      }

      if (url.pathname === '/docs' || url.pathname === '/docs/') {
        await serveFile(res, path.join(DOCS_DIR, 'index.html'), {
          transform: buffer =>
            Buffer.from(injectHarness(buffer.toString('utf8')), 'utf8')
        });
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
        await serveFile(res, path.join(DOCS_DIR, 'sw.js'), {
          transform: buffer =>
            Buffer.from(
              injectServiceWorkerHarness(buffer.toString('utf8')),
              'utf8'
            )
        });
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
    evaluate: options => evaluateRequests(requestLog, options)
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
        'Reload:    http://' + host + ':' + actualPort + '/docs/?scenario=background-reload&fresh=1',
        'Cancel:    http://' + host + ':' + actualPort + '/docs/?scenario=background-stop&fresh=1',
        'Drop:      http://' + host + ':' + actualPort + '/docs/?scenario=viewer-disconnect&fresh=1',
        'Double:    http://' + host + ':' + actualPort + '/docs/?scenario=rapid-double-send&fresh=1',
        'EarlyStop: http://' + host + ':' + actualPort + '/docs/?scenario=stop-before-create&fresh=1',
        'Ambiguous: http://' + host + ':' + actualPort + '/docs/?scenario=ambiguous-create&run=ambiguous-shared&fresh=1',
        'CrossTabA: http://' + host + ':' + actualPort + '/docs/?scenario=cross-tab-create&run=cross-tab-shared&fresh=1',
        'CrossTabB: http://' + host + ':' + actualPort + '/docs/?scenario=cross-tab-create&run=cross-tab-shared&fresh=0',
        'FenceA:    http://' + host + ':' + actualPort + '/docs/?scenario=lease-fence-loss&run=fence-shared&fresh=1',
        'FenceB:    http://' + host + ':' + actualPort + '/docs/?scenario=lease-fence-loss&run=fence-shared&fresh=0',
        'ImageError: http://' + host + ':' + actualPort + '/docs/?scenario=image-modality-error&run=image-modality-error&fresh=1',
        'Fixture:   ' + path.join(FIXTURES_DIR, 'linear-equation.png'),
        ''
      ].join('\n')
    );
  });
}
