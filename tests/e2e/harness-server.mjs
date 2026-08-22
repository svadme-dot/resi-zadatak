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
const VALID_SCENARIOS = new Set(['success', 'slow', 'fallback-429']);

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
  const checks = {
    model:
      body.model === 'gemini-3.6-flash',
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

  return {
    requestId: record.id,
    scenario: record.scenario,
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
  const relevant = requestLog.filter(record =>
    !scenario || record.scenario === scenario
  );
  const solverRecords = relevant;
  const requestAssertions = solverRecords.map(evaluateSolverRequest);
  const scenarioChecks = {};

  if (scenario === 'success') {
    scenarioChecks.completedStream = solverRecords.some(
      record => record.response?.outcome === 'completed'
    );
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

  if (scenario === 'slow' && options.expectStop) {
    scenarioChecks.clientAbortedSlowStream = solverRecords.some(
      record =>
        record.response?.closedEarly === true &&
        record.response?.eventsSent > 0
    );
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
      expectStop: Boolean(options.expectStop)
    },
    counts: {
      allMatchingRequests: relevant.length,
      solverRequests: solverRecords.length,
      solverRequestsWithImage: solverRecords.filter(record =>
        Boolean(findImagePart(record.body))
      ).length
    },
    scenarioChecks,
    requests: requestAssertions
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

function harnessBootstrap() {
  const lines = [
    '<script id="math-e2e-bootstrap">',
    '(function () {',
    '  var params = new URLSearchParams(location.search);',
    '  var allowed = ["success", "slow", "fallback-429"];',
    '  var scenario = params.get("scenario") || "success";',
    '  if (allowed.indexOf(scenario) === -1) scenario = "success";',
    '  var runId = params.get("run") || scenario;',
    '  if (params.get("fresh") !== "0") localStorage.clear();',
    '  var profiles = [',
    '    { key: "e2e-api-1", model: "gemini-3.6-flash" },',
    '    scenario === "fallback-429"',
    '      ? { key: "e2e-api-2", model: "gemini-3.6-flash" }',
    '      : { key: "", model: "gemini-3.6-flash" },',
    '    { key: "", model: "gemini-3.6-flash" },',
    '    { key: "", model: "gemini-3.6-flash" }',
    '  ];',
    '  localStorage.setItem(',
    '    "matematika_google_api_profiles_v1",',
    '    JSON.stringify(profiles)',
    '  );',
    '  localStorage.setItem("gemini_api_key_persistent_v1", "e2e-api-1");',
    '  var realFetch = window.fetch.bind(window);',
    '  window.fetch = function (input, init) {',
    '    var raw = typeof input === "string"',
    '      ? input',
    '      : input && input.url ? input.url : String(input || "");',
    '    if (raw.indexOf(' + JSON.stringify(GEMINI_ORIGIN) + ') === 0) {',
    '      var original = new URL(raw);',
    '      var mock = new URL("/__mock/gemini/v1beta/interactions", location.origin);',
    '      original.searchParams.forEach(function (value, key) {',
    '        mock.searchParams.append(key, value);',
    '      });',
    '      mock.searchParams.set("scenario", scenario);',
    '      mock.searchParams.set("run", runId);',
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
    '    requests: "/__harness__/requests?scenario=" + encodeURIComponent(scenario),',
    '    assertions: "/__harness__/assertions?scenario=" + encodeURIComponent(scenario)',
    '  };',
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
    '</ul></div>',
    '<div class="card"><h2>Evidence</h2><ul>',
    '<li><a href="/__harness__/requests">Recorded request JSON</a></li>',
    '<li><a href="/__harness__/assertions">All request assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=success">Success assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=fallback-429">Fallback assertions</a></li>',
    '<li><a href="/__harness__/assertions?scenario=slow&expectStop=1">Stop/abort assertions</a></li>',
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
  let nextRequestId = 1;

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
        nextRequestId = 1;
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

      if (url.pathname === '/__harness__/assertions') {
        sendJson(
          res,
          200,
          evaluateRequests(requestLog, {
            scenario: url.searchParams.get('scenario') || '',
            expectStop: url.searchParams.get('expectStop') === '1'
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
        const apiKey = String(req.headers['x-goog-api-key'] || '');
        const record = {
          id: nextRequestId++,
          receivedAt: new Date().toISOString(),
          run: url.searchParams.get('run') || '',
          scenario,
          kind: 'solve',
          apiKey,
          request: {
            method: req.method,
            path: url.pathname,
            alt: url.searchParams.get('alt') || '',
            accept: String(req.headers.accept || ''),
            contentType: String(req.headers['content-type'] || '')
          },
          body,
          response: null
        };
        requestLog.push(record);

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
        'Fixture:   ' + path.join(FIXTURES_DIR, 'linear-equation.png'),
        ''
      ].join('\n')
    );
  });
}
