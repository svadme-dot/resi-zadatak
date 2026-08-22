import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createHarnessServer } from './harness-server.mjs';

const validSolverBody = {
  model: 'gemini-3.7-flash',
  input: [
    {
      type: 'image',
      mime_type: 'image/jpeg',
      data: Buffer.from('synthetic math image').toString('base64')
    },
    {
      type: 'text',
      text: 'Reši zadatak korak po korak.'
    }
  ],
  stream: true,
  store: true,
  system_instruction: 'Test instruction.',
  tools: [{ type: 'code_execution' }],
  generation_config: {
    thinking_level: 'high',
    thinking_summaries: 'auto'
  }
};

const validBackgroundBody = {
  ...validSolverBody,
  stream: false,
  background: true
};

async function validPngBackgroundBody() {
  const png = await fs.readFile(
    new URL('./fixtures/linear-equation.png', import.meta.url)
  );
  return {
    ...validBackgroundBody,
    input: [
      {
        type: 'image',
        mime_type: 'image/png',
        data: png.toString('base64')
      },
      {
        type: 'text',
        text: 'Reši zadatak sa ove PNG slike.'
      }
    ]
  };
}

function apiHeaders(slot = 1, accept = 'application/json') {
  return {
    Accept: accept,
    'Content-Type': 'application/json',
    'x-goog-api-key': 'e2e-api-' + slot
  };
}

async function createBackground(base, scenario, run = scenario) {
  const response = await fetch(
    base +
      '/__mock/gemini/v1beta/interactions?scenario=' +
      encodeURIComponent(scenario) +
      '&run=' +
      encodeURIComponent(run),
    {
      method: 'POST',
      headers: apiHeaders(1),
      body: JSON.stringify(validBackgroundBody)
    }
  );
  assert.equal(response.status, 200);
  const interaction = await response.json();
  assert.equal(interaction.status, 'in_progress');
  assert.ok(interaction.id);
  return interaction.id;
}

function interactionUrl(base, id, scenario, query = '', tabId = '') {
  const params = new URLSearchParams(query.replace(/^\?/, ''));
  params.set('scenario', scenario);
  params.set('run', scenario);
  if (tabId) params.set('e2e_tab', tabId);
  return (
    base +
    '/__mock/gemini/v1beta/interactions/' +
    encodeURIComponent(id) +
    '?' +
    params.toString()
  );
}

async function registerClient(
  base,
  scenario,
  tabId,
  event = 'loaded',
  run = scenario
) {
  const response = await fetch(base + '/__harness__/client', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario, run, tabId, event })
  });
  assert.equal(response.status, 200);
}

function cancelUrl(base, id, scenario) {
  return (
    base +
    '/__mock/gemini/v1beta/interactions/' +
    encodeURIComponent(id) +
    '/cancel?scenario=' +
    encodeURIComponent(scenario) +
    '&run=' +
    encodeURIComponent(scenario)
  );
}

async function readUntil(reader, pattern) {
  const decoder = new TextDecoder();
  let text = '';

  while (!pattern.test(text)) {
    const item = await reader.read();
    if (item.done) break;
    text += decoder.decode(item.value, { stream: true });
  }

  const ids = [...text.matchAll(/"event_id":"([^"]+)"/g)];
  return {
    text,
    lastEventId: ids.at(-1)?.[1] || ''
  };
}

async function readToleratingDisconnect(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';

  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      text += decoder.decode(item.value, { stream: true });
    }
  } catch {}

  const ids = [...text.matchAll(/"event_id":"([^"]+)"/g)];
  return {
    text,
    lastEventId: ids.at(-1)?.[1] || ''
  };
}

async function withServer(run) {
  const harness = createHarnessServer();
  await new Promise(resolve =>
    harness.server.listen(0, '127.0.0.1', resolve)
  );
  const address = harness.server.address();
  const base = 'http://127.0.0.1:' + address.port;
  try {
    await run(base, harness);
  } finally {
    await new Promise(resolve => harness.server.close(resolve));
  }
}

test('serves an injected app without modifying the production file', async () => {
  await withServer(async base => {
    const response = await fetch(base + '/docs/?scenario=success&fresh=1');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /math-e2e-bootstrap/);
    assert.match(html, /__mock\/gemini\/v1beta\/interactions/);

    const fixture = await fetch(
      base + '/tests/e2e/fixtures/linear-equation.png'
    );
    assert.equal(fixture.status, 200);
    assert.equal(fixture.headers.get('content-type'), 'image/png');
    const bytes = new Uint8Array(await fixture.arrayBuffer());
    assert.deepEqual(
      [...bytes.slice(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10]
    );

    const serviceWorker = await fetch(base + '/docs/sw.js');
    assert.equal(serviceWorker.status, 200);
    assert.match(
      serviceWorker.headers.get('content-type') || '',
      /javascript/
    );
    const serviceWorkerText = await serviceWorker.text();
    assert.match(serviceWorkerText, /self\.addEventListener\("fetch"/);
    assert.match(serviceWorkerText, /math-e2e-sw-bypass/);
    assert.match(
      serviceWorkerText,
      /url\.pathname\.startsWith\("\/__mock\/"\)/
    );
    assert.doesNotMatch(html, /getRegistrations\(\).*unregister/s);
  });
});

test('success SSE emits thought, model output, and completion', async () => {
  await withServer(async base => {
    const response = await fetch(
      base +
        '/__mock/gemini/v1beta/interactions?alt=sse&scenario=success',
      {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          'x-goog-api-key': 'e2e-api-1'
        },
        body: JSON.stringify(validSolverBody)
      }
    );

    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /thought_summary/);
    assert.match(stream, /model_output/);
    assert.match(stream, /interaction\.completed/);

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=success'
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.requests[0].checks.noGoogleSearchOrGrounding, true);
  });
});

test('fallback scenario keeps API 1 at 429 and lets API 2 stream', async () => {
  await withServer(async base => {
    const endpoint =
      base +
      '/__mock/gemini/v1beta/interactions?alt=sse&scenario=fallback-429';

    const first = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'x-goog-api-key': 'e2e-api-1'
      },
      body: JSON.stringify(validSolverBody)
    });
    assert.equal(first.status, 429);

    const second = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'x-goog-api-key': 'e2e-api-2'
      },
      body: JSON.stringify(validSolverBody)
    });
    assert.equal(second.status, 200);
    assert.match(await second.text(), /interaction\.completed/);

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=fallback-429'
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.scenarioChecks.api1Returned429, true);
    assert.equal(assertions.scenarioChecks.api2Completed, true);
  });
});

test('background success creates once, streams by ID, then canonical-GETs final steps', async () => {
  await withServer(async base => {
    const scenario = 'success';
    const id = await createBackground(base, scenario, 'background-success');

    const stream = await fetch(
      interactionUrl(base, id, scenario, '?stream=true'),
      { headers: apiHeaders(1, 'text/event-stream') }
    );
    assert.equal(stream.status, 200);
    const streamText = await stream.text();
    assert.match(streamText, /"event_id":"[^"]+-event-001"/);
    assert.match(streamText, /interaction\.completed/);
    assert.doesNotMatch(
      streamText,
      /"event_type":"interaction\.completed"[\s\S]*?"steps"/
    );

    const canonical = await fetch(
      interactionUrl(base, id, scenario),
      { headers: apiHeaders(1) }
    ).then(item => item.json());
    assert.equal(canonical.status, 'completed');
    assert.ok(canonical.steps.some(step => step.type === 'thought'));
    assert.ok(canonical.steps.some(step => step.type === 'model_output'));

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=' + scenario
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.counts.createRequests, 1);
    assert.equal(assertions.transportChecks.apiRevisionAbsent, true);
    assert.deepEqual(assertions.requests[0].checks, {
      model: true,
      thinkingLevel: true,
      thinkingSummaries: true,
      toolsExactlyCodeExecution: true,
      noGoogleSearchOrGrounding: true,
      imagePayload: true
    });
  });
});

test('background fallback keeps the failed create on API 1 and the same-ID recovery on API 2', async () => {
  await withServer(async base => {
    const scenario = 'fallback-429';
    const endpoint =
      base +
      '/__mock/gemini/v1beta/interactions?scenario=' +
      scenario +
      '&run=background-fallback';

    const api1 = await fetch(endpoint, {
      method: 'POST',
      headers: apiHeaders(1),
      body: JSON.stringify(validBackgroundBody)
    });
    assert.equal(api1.status, 429);

    const api2 = await fetch(endpoint, {
      method: 'POST',
      headers: apiHeaders(2),
      body: JSON.stringify(validBackgroundBody)
    });
    assert.equal(api2.status, 200);
    const created = await api2.json();
    assert.equal(created.status, 'in_progress');

    const stream = await fetch(
      interactionUrl(base, created.id, scenario, '?stream=true'),
      { headers: apiHeaders(2, 'text/event-stream') }
    );
    assert.match(await stream.text(), /interaction\.completed/);

    const canonical = await fetch(
      interactionUrl(base, created.id, scenario),
      { headers: apiHeaders(2) }
    ).then(item => item.json());
    assert.equal(canonical.status, 'completed');

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=' + scenario
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.scenarioChecks.api1Returned429, true);
    assert.equal(assertions.scenarioChecks.api2Completed, true);
    assert.equal(assertions.scenarioChecks.api1WasBeforeApi2, true);
    assert.equal(assertions.transportChecks.apiRevisionAbsent, true);
  });
});

test('legacy success mock demonstrates why the real PNG modality failure was previously invisible', async () => {
  await withServer(async base => {
    const body = await validPngBackgroundBody();
    const response = await fetch(
      base +
        '/__mock/gemini/v1beta/interactions?scenario=success&run=legacy-png-success',
      {
        method: 'POST',
        headers: apiHeaders(1),
        body: JSON.stringify(body)
      }
    );
    const created = await response.json();
    const stream = await fetch(
      interactionUrl(base, created.id, 'success', '?stream=true'),
      { headers: apiHeaders(1, 'text/event-stream') }
    );
    assert.match(await stream.text(), /interaction\.completed/);
    const canonical = await fetch(
      interactionUrl(base, created.id, 'success'),
      { headers: apiHeaders(1) }
    ).then(item => item.json());

    // This deterministic success is exactly the old blind spot: it proves
    // only that the browser sent a syntactically valid request, not that the
    // Google backend accepted image modality for its internal agent route.
    assert.equal(canonical.status, 'completed');
    assert.equal(canonical.errors, undefined);
  });
});

test('PNG modality terminal errors[] is a failed Interaction, never fake success or user Stop', async () => {
  await withServer(async base => {
    const scenario = 'image-modality-error';
    const tabId = 'tab-png-modality';
    const body = await validPngBackgroundBody();
    await registerClient(base, scenario, tabId);

    const created = await fetch(
      base +
        '/__mock/gemini/v1beta/interactions?scenario=' +
        scenario +
        '&e2e_tab=' +
        tabId,
      {
        method: 'POST',
        headers: apiHeaders(1),
        body: JSON.stringify(body)
      }
    ).then(item => item.json());
    assert.equal(created.status, 'in_progress');

    const stream = await fetch(
      interactionUrl(
        base,
        created.id,
        scenario,
        '?stream=true',
        tabId
      ),
      { headers: apiHeaders(1, 'text/event-stream') }
    );
    const streamText = await stream.text();
    assert.match(streamText, /interaction\.completed/);
    assert.match(streamText, /"status":"failed"/);
    assert.doesNotMatch(streamText, /model_output/);

    const canonical = await fetch(
      interactionUrl(base, created.id, scenario, '', tabId),
      { headers: apiHeaders(1) }
    ).then(item => item.json());
    assert.equal(canonical.status, 'failed');
    assert.deepEqual(canonical.errors, [
      {
        code: 400,
        message:
          'Image input modality is not enabled for models/gemini-3.7-flash-agent'
      }
    ]);

    // Until the real app reports its terminal UI classification, the harness
    // must fail closed instead of treating protocol completion as success.
    const beforeUi = await fetch(
      base + '/__harness__/assertions?scenario=' + scenario
    ).then(item => item.json());
    assert.equal(beforeUi.ok, false);
    assert.equal(
      beforeUi.scenarioChecks.googleErrorsArrayWasCanonicalFailure,
      true
    );
    assert.equal(
      beforeUi.scenarioChecks.appClassifiedFailureAsInterrupted,
      false
    );

    // Browser runs emit this automatically from persisted chat state. The
    // unit protocol test supplies the same evidence deterministically.
    await fetch(base + '/__harness__/client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenario,
        run: scenario,
        tabId,
        event: 'terminal-classification',
        detail: {
          completionState: 'interrupted',
          errorSurfaced: true
        }
      })
    });

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=' + scenario
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.scenarioChecks.publicFlashModelNotAgent, true);
    assert.equal(
      assertions.scenarioChecks.rasterBytesMatchDeclaredMime,
      true
    );
    assert.equal(
      assertions.scenarioChecks.appClassifiedFailureAsInterrupted,
      true
    );
    assert.equal(assertions.scenarioChecks.notUserStop, true);
    assert.equal(assertions.counts.cancelRequests, 0);
  });
});

test('source contract extracts errors[] and reserves stopped state for cancelled status', async () => {
  const source = await fs.readFile(
    new URL('../../src/math-app.html', import.meta.url),
    'utf8'
  );
  assert.match(
    source,
    /const DEFAULT_MODEL = "gemini-3\.7-flash";/
  );
  assert.doesNotMatch(
    source,
    /const DEFAULT_MODEL = "[^"]*-agent";/
  );
  const match = source.match(
    /function terminalInteractionError\(interaction\) \{[\s\S]*?\n  \}\n\n  function isEligibleTerminalFallback/
  );
  assert.ok(match, 'terminalInteractionError must remain discoverable');
  const functionSource = match[0].replace(
    /\n\n  function isEligibleTerminalFallback$/,
    ''
  );
  const terminalInteractionError = Function(
    '"use strict"; return (' + functionSource + ');'
  )();
  const interaction = {
    status: 'failed',
    errors: [
      {
        code: 400,
        message:
          'Image input modality is not enabled for models/gemini-3.7-flash-agent'
      }
    ]
  };
  const error = terminalInteractionError(interaction);
  assert.equal(error.status, 400);
  assert.match(error.message, /Image input modality is not enabled/);
  assert.equal(error.terminalInteraction, interaction);

  assert.match(
    source,
    /if \(terminalStatus === "cancelled"\) \{\s*return finalizeStoppedJob\(\);\s*\}/
  );
  assert.match(
    source,
    /const terminalError = terminalInteractionError\(terminal\);/
  );
  assert.doesNotMatch(
    source,
    /terminalStatus === "failed"[\s\S]{0,180}finalizeStoppedJob\(\)/
  );
});

test('request diagnostics fail closed if Api-Revision is ever introduced', async () => {
  await withServer(async base => {
    const scenario = 'success';
    const response = await fetch(
      base + '/__mock/gemini/v1beta/interactions?scenario=' + scenario,
      {
        method: 'POST',
        headers: {
          ...apiHeaders(1),
          'Api-Revision': 'must-not-be-sent'
        },
        body: JSON.stringify(validBackgroundBody)
      }
    );
    assert.equal(response.status, 200);

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=' + scenario
    ).then(item => item.json());
    assert.equal(assertions.transportChecks.apiRevisionAbsent, false);
    assert.equal(assertions.ok, false);
  });
});

test('background job survives viewer reload and resumes from last_event_id', async () => {
  await withServer(async base => {
    const scenario = 'background-reload';
    const id = await createBackground(base, scenario);
    const controller = new AbortController();
    const first = await fetch(
      interactionUrl(base, id, scenario, '?stream=true'),
      {
        headers: apiHeaders(1, 'text/event-stream'),
        signal: controller.signal
      }
    );
    assert.equal(first.status, 200);
    const firstReader = first.body.getReader();
    const partial = await readUntil(firstReader, /event-005/);
    assert.match(partial.text, /2x=8/);
    assert.match(partial.lastEventId, /event-005$/);

    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 60));

    const resumed = await fetch(
      interactionUrl(
        base,
        id,
        scenario,
        '?stream=true&last_event_id=' +
          encodeURIComponent(partial.lastEventId)
      ),
      {
        headers: apiHeaders(1, 'text/event-stream')
      }
    );
    const resumedReader = resumed.body.getReader();
    const resumedTerminal = await readUntil(resumedReader, /event-007/);
    assert.match(resumedTerminal.text, /event-006/);
    assert.match(resumedTerminal.text, /interaction\.completed/);
    assert.doesNotMatch(
      resumedTerminal.text,
      /"event_type":"interaction\.completed"[\s\S]*?"steps"/
    );
    // This exactly matches the app: stop reading after the sparse terminal
    // event and switch immediately to canonical GET, without waiting for DONE.
    await resumedReader.cancel();
    await new Promise(resolve => setTimeout(resolve, 60));

    const canonical = await fetch(
      interactionUrl(base, id, scenario),
      { headers: apiHeaders(1) }
    ).then(item => item.json());
    assert.equal(canonical.status, 'completed');
    assert.ok(canonical.steps.some(step => step.type === 'model_output'));

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=' + scenario
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.scenarioChecks.createdOnce, true);
    assert.equal(
      assertions.scenarioChecks.sparseCompletionFollowedByCanonicalGet,
      true
    );

    const evidence = await fetch(
      base + '/__harness__/requests?scenario=' + scenario
    ).then(item => item.json());
    const resumedRecord = evidence.requests.filter(
      record =>
        record.kind === 'retrieve-stream' &&
        record.request.lastEventId
    )[0];
    assert.equal(resumedRecord.response.terminalEventSent, true);
    assert.equal(resumedRecord.response.outcome, 'completed-sparse');
    assert.equal(resumedRecord.response.closedAfterTerminal, true);
    assert.equal(resumedRecord.response.closedEarly, false);
  });
});

test('Stop cancels the background job after partial output without deleting it', async () => {
  await withServer(async base => {
    const scenario = 'background-stop';
    const id = await createBackground(base, scenario);
    const stream = await fetch(
      interactionUrl(base, id, scenario, '?stream=true'),
      { headers: apiHeaders(1, 'text/event-stream') }
    );
    const reader = stream.body.getReader();
    const partial = await readUntil(reader, /event-005/);
    assert.match(partial.text, /2x=8/);

    const cancelled = await fetch(
      cancelUrl(base, id, scenario),
      {
        method: 'POST',
        headers: apiHeaders(1),
        body: '{}'
      }
    );
    assert.equal(cancelled.status, 200);
    const resource = await cancelled.json();
    assert.equal(resource.status, 'cancelled');
    assert.ok(resource.steps.some(step => step.type === 'model_output'));

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=' + scenario
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.scenarioChecks.partialOutputBeforeCancel, true);
    assert.equal(assertions.scenarioChecks.cancelEndpointCalled, true);

    const evidenceText = await fetch(
      base + '/__harness__/requests?scenario=' + scenario
    ).then(item => item.text());
    assert.doesNotMatch(evidenceText, /x-goog-api-key|e2e-api-1/i);
  });
});

test('viewer disconnect reconnects the same job and never falls through to API 2', async () => {
  await withServer(async base => {
    const scenario = 'viewer-disconnect';
    const id = await createBackground(base, scenario);
    const dropped = await fetch(
      interactionUrl(base, id, scenario, '?stream=true'),
      { headers: apiHeaders(1, 'text/event-stream') }
    );
    const partial = await readToleratingDisconnect(dropped);
    assert.match(partial.text, /2x=8/);
    assert.match(partial.lastEventId, /event-005$/);

    const resumed = await fetch(
      interactionUrl(
        base,
        id,
        scenario,
        '?stream=true&last_event_id=' +
          encodeURIComponent(partial.lastEventId)
      ),
      { headers: apiHeaders(1, 'text/event-stream') }
    );
    assert.match(await resumed.text(), /interaction\.completed/);

    const canonical = await fetch(
      interactionUrl(base, id, scenario),
      { headers: apiHeaders(1) }
    ).then(item => item.json());
    assert.equal(canonical.status, 'completed');

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=' + scenario
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.scenarioChecks.viewerWasDisconnected, true);
    assert.equal(assertions.scenarioChecks.secondStreamUsedLastEventId, true);
    assert.equal(assertions.scenarioChecks.noApi2, true);
  });
});

test('rapid-double-send evidence requires only one delayed create POST', async () => {
  await withServer(async base => {
    const scenario = 'rapid-double-send';
    const startedAt = Date.now();
    const id = await createBackground(base, scenario);
    assert.ok(Date.now() - startedAt >= 600);
    assert.ok(id);

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=' + scenario
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.scenarioChecks.exactlyOneCreatePost, true);
    assert.equal(assertions.scenarioChecks.createResponseDelivered, true);
    assert.equal(assertions.transportChecks.apiRevisionAbsent, true);
  });
});

test('Stop intent before create response waits for ID and then cancels that job', async () => {
  await withServer(async base => {
    const scenario = 'stop-before-create';
    const createPromise = createBackground(base, scenario);

    await new Promise(resolve => setTimeout(resolve, 80));
    const pendingEvidence = await fetch(
      base + '/__harness__/requests?scenario=' + scenario
    ).then(item => item.json());
    assert.equal(pendingEvidence.requests.length, 1);
    assert.equal(
      pendingEvidence.requests[0].response.outcome,
      'create-response-pending'
    );

    const id = await createPromise;
    const cancelled = await fetch(cancelUrl(base, id, scenario), {
      method: 'POST',
      headers: apiHeaders(1),
      body: '{}'
    }).then(item => item.json());
    assert.equal(cancelled.id, id);
    assert.equal(cancelled.status, 'cancelled');

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=' + scenario
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.scenarioChecks.exactlyOneCreatePost, true);
    assert.equal(assertions.scenarioChecks.createResponseWasNotAborted, true);
    assert.equal(
      assertions.scenarioChecks.cancelledReturnedInteraction,
      true
    );
    assert.equal(assertions.scenarioChecks.noOrphanOrSecondCreate, true);
    assert.equal(assertions.scenarioChecks.noApi2, true);
  });
});

test('ambiguous accepted create drops transport and forbids automatic retry or API 2', async () => {
  await withServer(async base => {
    const scenario = 'ambiguous-create';
    await registerClient(base, scenario, 'tab-before-drop', 'loaded', 'ambiguous-run');

    await assert.rejects(
      fetch(
        base +
          '/__mock/gemini/v1beta/interactions?scenario=' +
          scenario +
          '&run=ambiguous-run&e2e_tab=tab-before-drop',
        {
          method: 'POST',
          headers: apiHeaders(1),
          body: JSON.stringify(validBackgroundBody)
        }
      ),
      /fetch failed|socket|other side closed/i
    );

    // A reload is another client document, but it must not perform a second
    // POST while the accepted create has no recoverable interaction ID.
    await registerClient(base, scenario, 'tab-after-reload', 'loaded', 'ambiguous-run');

    const jobs = await fetch(base + '/__harness__/jobs').then(item => item.json());
    assert.equal(jobs.count, 1);
    assert.equal(jobs.jobs[0].status, 'in_progress');

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=' + scenario
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.scenarioChecks.exactlyOneCreatePost, true);
    assert.equal(
      assertions.scenarioChecks.serverAcceptedButResponseWasLost,
      true
    );
    assert.equal(assertions.scenarioChecks.noAutomaticRetryOrApi2, true);
    assert.equal(
      assertions.scenarioChecks.noFollowupWithoutInteractionId,
      true
    );
  });
});

test('cross-tab gate evidence accepts two loaded tabs but only one creator/finalizer', async () => {
  await withServer(async base => {
    const scenario = 'cross-tab-create';
    const run = 'two-tabs-one-create';
    const ownerTab = 'tab-owner';
    await registerClient(base, scenario, ownerTab, 'loaded', run);
    await registerClient(base, scenario, 'tab-loser', 'loaded', run);

    const createdResponse = await fetch(
      base +
        '/__mock/gemini/v1beta/interactions?scenario=' +
        scenario +
        '&run=' +
        run +
        '&e2e_tab=' +
        ownerTab,
      {
        method: 'POST',
        headers: apiHeaders(1),
        body: JSON.stringify(validBackgroundBody)
      }
    );
    const created = await createdResponse.json();

    const stream = await fetch(
      interactionUrl(
        base,
        created.id,
        scenario,
        '?stream=true',
        ownerTab
      ),
      { headers: apiHeaders(1, 'text/event-stream') }
    );
    assert.match(await stream.text(), /interaction\.completed/);

    const canonical = await fetch(
      interactionUrl(base, created.id, scenario, '', ownerTab),
      { headers: apiHeaders(1) }
    ).then(item => item.json());
    assert.equal(canonical.status, 'completed');

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=' + scenario
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.scenarioChecks.twoTabsLoaded, true);
    assert.equal(assertions.scenarioChecks.exactlyOneCreatePost, true);
    assert.equal(assertions.scenarioChecks.onlyLeaseOwnerUsedGemini, true);
    assert.equal(assertions.scenarioChecks.singleFinalizer, true);
  });
});

test('fence-loss evidence requires losing viewer to stop without finalizing', async () => {
  await withServer(async base => {
    const scenario = 'lease-fence-loss';
    const ownerTab = 'tab-old-owner';
    const stealerTab = 'tab-fence-stealer';
    await registerClient(base, scenario, ownerTab);
    await registerClient(base, scenario, stealerTab);

    const create = await fetch(
      base +
        '/__mock/gemini/v1beta/interactions?scenario=' +
        scenario +
        '&e2e_tab=' +
        ownerTab,
      {
        method: 'POST',
        headers: apiHeaders(1),
        body: JSON.stringify(validBackgroundBody)
      }
    ).then(item => item.json());

    const stream = await fetch(
      interactionUrl(
        base,
        create.id,
        scenario,
        '?stream=true',
        ownerTab
      ),
      { headers: apiHeaders(1, 'text/event-stream') }
    );
    const reader = stream.body.getReader();
    const partial = await readUntil(reader, /event-005/);
    assert.match(partial.text, /2x=8/);

    await registerClient(
      base,
      scenario,
      stealerTab,
      'forced-fence-loss'
    );
    await reader.cancel();
    await new Promise(resolve => setTimeout(resolve, 60));

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=' + scenario
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.scenarioChecks.fenceWasChangedByOtherTab, true);
    assert.equal(
      assertions.scenarioChecks.losingViewerStoppedBeforeTerminal,
      true
    );
    assert.equal(assertions.scenarioChecks.losingTabDidNotFinalize, true);
    assert.equal(assertions.scenarioChecks.noSecondCreateOrApi2, true);
  });
});
