import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createHarnessServer } from './harness-server.mjs';

const RETRY_PROMPT =
  'E2E ponovni pokušaj: reši jednačinu 2x + 3 = 11.';
const PRIMARY_MODEL = 'gemini-3.7-flash';
const FALLBACK_MODEL = 'gemini-3.6-flash';
const IMAGE_MODALITY_MESSAGE =
  'Image input modality is not enabled for models/gemini-3.7-flash-agent';
const UNSUPPORTED_IMAGE_PAYLOAD_MESSAGE =
  'Unsupported image format/MIME';
const HIGH_DEMAND_MESSAGE =
  'gemini-3.7-flash is currently experiencing high demand, spikes in demand are usually temporary. Please try again later.';
const EXPECTED_EIGHT_PROFILE_ORDER = [
  ['e2e-api-1', PRIMARY_MODEL],
  ['e2e-api-2', PRIMARY_MODEL],
  ['e2e-api-3', PRIMARY_MODEL],
  ['e2e-api-4', PRIMARY_MODEL],
  ['e2e-api-1', FALLBACK_MODEL],
  ['e2e-api-2', FALLBACK_MODEL],
  ['e2e-api-3', FALLBACK_MODEL],
  ['e2e-api-4', FALLBACK_MODEL]
];

const validSolverBody = {
  model: PRIMARY_MODEL,
  input: [
    {
      type: 'image',
      mime_type: 'image/jpeg',
      data: Buffer.from('synthetic math image').toString('base64'),
      resolution: 'high'
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

async function retrySolverBody() {
  const png = await readFile(
    new URL('./fixtures/linear-equation.png', import.meta.url)
  );
  return {
    ...validSolverBody,
    input: [
      {
        type: 'image',
        mime_type: 'image/png',
        data: png.toString('base64'),
        resolution: 'high'
      },
      {
        type: 'text',
        text: RETRY_PROMPT
      }
    ]
  };
}

function retryEvidence(label, completed = false) {
  return {
    label,
    stage: label,
    loadOrdinal: 2,
    storage: {
      chatFound: true,
      roles: completed ? ['user', 'model'] : ['user'],
      totalMessages: completed ? 2 : 1,
      matchingUserMessages: 1,
      modelMessages: completed ? 1 : 0,
      lastRole: completed ? 'model' : 'user',
      savedPrompt: RETRY_PROMPT,
      hadImage: true,
      imageIdPresent: true,
      completedModels: completed ? 1 : 0
    },
    indexedImage: {
      found: true,
      mimeType: 'image/png',
      bytes: 4732
    },
    dom: {
      userBubbles: 1,
      matchingUserBubbles: 1,
      modelBubbles: completed ? 1 : 0,
      completedModels: completed ? 1 : 0,
      promptValue: '',
      sendDisabled: false
    }
  };
}

async function postRetryEvidence(base, run, evidence) {
  const response = await fetch(
    base +
      '/__harness__/client-evidence?scenario=retry-after-reload&run=' +
      encodeURIComponent(run),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(evidence)
    }
  );
  assert.equal(response.status, 200);
}

async function postSolver(base, endpoint, body, apiKey, signal) {
  return fetch(base + endpoint, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body),
    signal
  });
}

function solverBodyForModel(model) {
  return {
    ...validSolverBody,
    model
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

    const retryPage = await fetch(
      base + '/docs/?scenario=retry-after-reload&fresh=1&run=inject-test'
    );
    const retryHtml = await retryPage.text();
    assert.match(retryHtml, /retry-after-reload-driver\.js/);
    assert.match(retryHtml, /Document\.prototype\.write/);

    const retryDriver = await fetch(
      base + '/__harness__/retry-after-reload-driver.js'
    );
    assert.equal(retryDriver.status, 200);
    assert.equal(
      retryDriver.headers.get('content-type'),
      'text/javascript; charset=utf-8'
    );
    assert.match(await retryDriver.text(), /__MATH_E2E_RETRY__/);
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

test('request oracle rejects an agent alias and media_resolution impostor', async () => {
  await withServer(async base => {
    const invalidBody = {
      ...validSolverBody,
      model: 'gemini-3.7-flash-agent',
      input: validSolverBody.input.map(part =>
        part.type === 'image'
          ? {
              type: part.type,
              mime_type: part.mime_type,
              data: part.data,
              media_resolution: 'high'
            }
          : { ...part }
      )
    };
    const response = await postSolver(
      base,
      '/__mock/gemini/v1beta/interactions?alt=sse&scenario=success',
      invalidBody,
      'e2e-api-1'
    );
    await response.text();

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=success'
    ).then(item => item.json());
    assert.equal(assertions.ok, false);
    assert.equal(assertions.requests[0].checks.model, false);
    assert.equal(assertions.requests[0].checks.imageResolutionHigh, false);
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

test('fallback follows the exact four-key 3.7 then four-key 3.6 order', async () => {
  await withServer(async base => {
    const run = 'eight-profile-order';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=fallback-eight&run=' + run;

    for (let index = 0; index < EXPECTED_EIGHT_PROFILE_ORDER.length; index++) {
      const [apiKey, model] = EXPECTED_EIGHT_PROFILE_ORDER[index];
      const response = await postSolver(
        base,
        endpoint,
        solverBodyForModel(model),
        apiKey
      );

      if (index < 7) {
        assert.equal(response.status, 401);
      } else {
        assert.equal(response.status, 200);
        assert.match(await response.text(), /interaction\.completed/);
      }
    }

    const assertions = await fetch(
      base +
        '/__harness__/assertions?scenario=fallback-eight&run=' +
        run
    ).then(item => item.json());

    assert.equal(assertions.ok, true);
    assert.deepEqual(assertions.scenarioChecks, {
      exactEightProfileOrder: true,
      firstSevenWereClassifiedFailures: true,
      eighthProfileCompleted: true
    });
    assert.equal(assertions.counts.solverRequests, 8);
    assert.equal(
      assertions.requests.every(request =>
        request.checks.model &&
        request.checks.thinkingLevel &&
        request.checks.thinkingSummaries &&
        request.checks.toolsExactlyCodeExecution &&
        request.checks.noGoogleSearchOrGrounding &&
        request.checks.imagePayload &&
        request.checks.imageResolutionHigh
      ),
      true
    );
  });
});

test('single-line SSE modality error advances to the next ordered tuple', async () => {
  await withServer(async base => {
    const run = 'single-line-modality-error';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=sse-error-next-profile&run=' + run;
    const first = await postSolver(
      base,
      endpoint,
      solverBodyForModel(PRIMARY_MODEL),
      'e2e-api-1'
    );
    assert.equal(first.status, 200);
    const wire = await first.text();
    const nonEmptyLines = wire.split(/\r?\n/).filter(Boolean);
    assert.equal(nonEmptyLines.length, 1);
    assert.match(nonEmptyLines[0], /"event_type":"error"/);
    assert.match(nonEmptyLines[0], new RegExp(IMAGE_MODALITY_MESSAGE));

    const second = await postSolver(
      base,
      endpoint,
      solverBodyForModel(PRIMARY_MODEL),
      'e2e-api-2'
    );
    assert.equal(second.status, 200);
    assert.match(await second.text(), /interaction\.completed/);

    const assertions = await fetch(
      base +
        '/__harness__/assertions?scenario=sse-error-next-profile&run=' +
        run
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.deepEqual(assertions.scenarioChecks, {
      singleLineSseErrorWasSurfaced: true,
      advancedToNextOrderedTuple: true,
      noSyncDuplicateForSseError: true
    });
    assert.equal(assertions.counts.solverRequests, 2);
  });
});

test('failed interaction completion advances without a sync duplicate', async () => {
  await withServer(async (base, harness) => {
    const run = 'terminal-failed-modality';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=terminal-failed-next-profile&run=' + run;
    const first = await postSolver(
      base,
      endpoint,
      solverBodyForModel(PRIMARY_MODEL),
      'e2e-api-1'
    );
    assert.equal(first.status, 200);
    const wire = await first.text();
    const firstDataLine = wire
      .split(/\r?\n/)
      .find(line => line.startsWith('data: {'));
    assert.ok(firstDataLine);
    const terminalEvent = JSON.parse(firstDataLine.slice(5).trim());
    assert.equal(terminalEvent.event_type, 'interaction.completed');
    assert.equal(terminalEvent.interaction.status, 'failed');
    assert.equal(
      terminalEvent.interaction.errors[0].message,
      IMAGE_MODALITY_MESSAGE
    );

    const second = await postSolver(
      base,
      endpoint,
      solverBodyForModel(PRIMARY_MODEL),
      'e2e-api-2'
    );
    assert.equal(second.status, 200);
    assert.match(await second.text(), /interaction\.completed/);

    const assertions = await fetch(
      base +
        '/__harness__/assertions?scenario=terminal-failed-next-profile&run=' +
        run
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.deepEqual(assertions.scenarioChecks, {
      failedCompletionErrorsWereSurfaced: true,
      failedCompletionAdvancedDirectly: true,
      zeroSyncDuplicatesOnFailedTuple: true
    });
    assert.equal(assertions.counts.solverRequests, 2);
    assert.equal(
      harness.requestLog
        .filter(record => record.run === run)
        .some(record => record.body?.stream === false),
      false
    );
  });
});

test('thinking-only high demand reaches the eighth 3.7-to-3.6 tuple', async () => {
  await withServer(async base => {
    const run = 'thinking-only-high-demand';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=thought-high-demand-to-3.6&run=' + run;
    const expectedOrder = EXPECTED_EIGHT_PROFILE_ORDER;

    for (let index = 0; index < expectedOrder.length; index++) {
      const [apiKey, model] = expectedOrder[index];
      const response = await postSolver(
        base,
        endpoint,
        solverBodyForModel(model),
        apiKey
      );
      assert.equal(response.status, 200);
      const wire = await response.text();

      if (index < 7) {
        const thoughtIndex = wire.indexOf('"type":"thought_summary"');
        const failureIndex = index % 2 === 0
          ? wire.indexOf('"event_type":"error"')
          : wire.indexOf('"status":"failed"');
        assert.ok(thoughtIndex >= 0);
        assert.ok(failureIndex > thoughtIndex);
        assert.equal(wire.includes('"type":"model_output"'), false);
        assert.match(wire, /currently experiencing high demand/i);
      } else {
        assert.match(wire, /interaction\.completed/);
        assert.match(wire, /model_output/);
      }
    }

    const assertions = await fetch(
      base +
        '/__harness__/assertions?scenario=thought-high-demand-to-3.6&run=' +
        run
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.deepEqual(assertions.scenarioChecks, {
      exactThoughtHighDemandFallbackOrder: true,
      allFailedTuplesHadThoughtButNoAnswer: true,
      streamAndTerminalDemandErrorsWereHandled: true,
      eighthTupleCompleted: true,
      noSyncDuplicateDuringDemandFallback: true
    });
    assert.equal(assertions.counts.solverRequests, 8);
  });
});

test('high demand after answer output stops without profile fallback', async () => {
  await withServer(async base => {
    const run = 'answer-high-demand-guard';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=answer-high-demand-no-fallback&run=' + run;
    const response = await postSolver(
      base,
      endpoint,
      solverBodyForModel(PRIMARY_MODEL),
      'e2e-api-1'
    );
    assert.equal(response.status, 200);
    const wire = await response.text();
    const thoughtIndex = wire.indexOf('"type":"thought_summary"');
    const answerIndex = wire.indexOf('"type":"model_output"');
    const failureIndex = wire.indexOf('"event_type":"error"');
    assert.ok(thoughtIndex >= 0);
    assert.ok(answerIndex > thoughtIndex);
    assert.ok(failureIndex > answerIndex);
    assert.ok(wire.includes(HIGH_DEMAND_MESSAGE));

    const assertionsUrl =
      base +
      '/__harness__/assertions?scenario=answer-high-demand-no-fallback&run=' +
      run;
    const assertions = await fetch(assertionsUrl).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.deepEqual(assertions.scenarioChecks, {
      answerThenHighDemandWasDelivered: true,
      answerThenHighDemandStoppedImmediately: true
    });
    assert.equal(assertions.counts.solverRequests, 1);

    const forbiddenSecond = await postSolver(
      base,
      endpoint,
      solverBodyForModel(PRIMARY_MODEL),
      'e2e-api-2'
    );
    assert.equal(forbiddenSecond.status, 409);
    const afterForbidden = await fetch(assertionsUrl).then(item => item.json());
    assert.equal(afterForbidden.ok, false);
    assert.equal(
      afterForbidden.scenarioChecks.answerThenHighDemandStoppedImmediately,
      false
    );
  });
});

test('unsupported image format payload error never traverses profiles', async () => {
  await withServer(async base => {
    const run = 'unsupported-image-payload';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=payload-error-no-fallback&run=' + run;
    const first = await postSolver(
      base,
      endpoint,
      solverBodyForModel(PRIMARY_MODEL),
      'e2e-api-1'
    );
    assert.equal(first.status, 200);
    assert.match(await first.text(), new RegExp(UNSUPPORTED_IMAGE_PAYLOAD_MESSAGE));

    const assertionsUrl =
      base +
      '/__harness__/assertions?scenario=payload-error-no-fallback&run=' +
      run;
    const assertions = await fetch(assertionsUrl).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.deepEqual(assertions.scenarioChecks, {
      payloadErrorWasSurfaced: true,
      payloadErrorStoppedImmediately: true
    });
    assert.equal(assertions.counts.solverRequests, 1);

    const forbiddenSecond = await postSolver(
      base,
      endpoint,
      solverBodyForModel(PRIMARY_MODEL),
      'e2e-api-2'
    );
    assert.equal(forbiddenSecond.status, 409);
    const afterForbidden = await fetch(assertionsUrl).then(item => item.json());
    assert.equal(afterForbidden.ok, false);
    assert.equal(
      afterForbidden.scenarioChecks.payloadErrorStoppedImmediately,
      false
    );
  });
});

test('user Stop after partial output never continues to another profile', async () => {
  await withServer(async base => {
    const run = 'stop-no-continuation';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=slow&run=' + run;
    const controller = new AbortController();
    const response = await postSolver(
      base,
      endpoint,
      validSolverBody,
      'e2e-api-1',
      controller.signal
    );
    assert.equal(response.status, 200);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('Oduzmemo 3 sa obe strane')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      received += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    try { await reader.read(); } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 40));

    const assertions = await fetch(
      base +
        '/__harness__/assertions?scenario=slow&expectStop=1&run=' +
        run
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.scenarioChecks.clientAbortedSlowStream, true);
    assert.equal(assertions.scenarioChecks.stopDidNotContinueProfiles, true);
    assert.equal(assertions.counts.solverRequests, 1);
  });
});

test('transport failure after partial output never continues profiles', async () => {
  await withServer(async base => {
    const run = 'partial-no-continuation';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=partial-no-continue&run=' + run;
    const response = await postSolver(
      base,
      endpoint,
      validSolverBody,
      'e2e-api-1'
    );
    assert.equal(response.status, 200);
    await assert.rejects(response.text());
    await new Promise(resolve => setTimeout(resolve, 40));

    const assertionsUrl =
      base +
      '/__harness__/assertions?scenario=partial-no-continue&run=' +
      run;
    const assertions = await fetch(assertionsUrl).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.scenarioChecks.partialOutputWasDelivered, true);
    assert.equal(
      assertions.scenarioChecks.partialOutputDidNotContinueProfiles,
      true
    );
    assert.equal(assertions.counts.solverRequests, 1);

    const unexpectedContinuation = await postSolver(
      base,
      endpoint,
      solverBodyForModel(PRIMARY_MODEL),
      'e2e-api-2'
    );
    assert.equal(unexpectedContinuation.status, 409);
    const afterUnexpected = await fetch(assertionsUrl).then(item => item.json());
    assert.equal(afterUnexpected.ok, false);
    assert.equal(
      afterUnexpected.scenarioChecks.partialOutputDidNotContinueProfiles,
      false
    );
  });
});

test('reload retry reuses the saved prompt and exact real image once', async () => {
  await withServer(async base => {
    const run = 'retry-contract';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=retry-after-reload&run=' + run;
    const body = await retrySolverBody();

    const controller = new AbortController();
    const first = await postSolver(
      base,
      endpoint,
      body,
      'e2e-api-1',
      controller.signal
    );
    assert.equal(first.status, 200);
    controller.abort();
    await assert.rejects(first.text(), error => error?.name === 'AbortError');
    await new Promise(resolve => setTimeout(resolve, 30));

    await postRetryEvidence(
      base,
      run,
      retryEvidence('after-reload-pending-open')
    );
    await postRetryEvidence(
      base,
      run,
      retryEvidence('retry-request-started')
    );

    const retry = await postSolver(
      base,
      endpoint,
      body,
      'e2e-api-1'
    );
    assert.equal(retry.status, 200);
    assert.match(await retry.text(), /interaction\.completed/);

    await postRetryEvidence(
      base,
      run,
      retryEvidence('after-retry-completed', true)
    );
    await postRetryEvidence(
      base,
      run,
      retryEvidence('after-completed-empty-send', true)
    );

    const assertions = await fetch(
      base +
        '/__harness__/assertions?scenario=retry-after-reload&run=' +
        run
    ).then(item => item.json());

    assert.equal(assertions.ok, true);
    assert.deepEqual(assertions.scenarioChecks, {
      firstRequestAbortedForReload: true,
      savedUnansweredPromptSurvivedReload: true,
      savedRealImageSurvivedReload: true,
      retryPromptIsExact: true,
      retryImageIsByteExact: true,
      noDuplicateUserOnRetry: true,
      retryCompleted: true,
      completedAnswerIsNotResendable: true,
      noUnexpectedApi2: true
    });
    assert.equal(assertions.counts.solverRequests, 2);

    const unexpectedThird = await postSolver(
      base,
      endpoint,
      body,
      'e2e-api-1'
    );
    assert.equal(unexpectedThird.status, 200);
    await unexpectedThird.text();

    const afterThird = await fetch(
      base +
        '/__harness__/assertions?scenario=retry-after-reload&run=' +
        run
    ).then(item => item.json());
    assert.equal(afterThird.ok, false);
    assert.equal(
      afterThird.scenarioChecks.completedAnswerIsNotResendable,
      false
    );
  });
});

test('reload retry oracle rejects changed prompt, image, or API 2', async () => {
  await withServer(async base => {
    const run = 'retry-negative';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=retry-after-reload&run=' + run;
    const body = await retrySolverBody();
    const controller = new AbortController();
    const first = await postSolver(
      base,
      endpoint,
      body,
      'e2e-api-1',
      controller.signal
    );
    controller.abort();
    await assert.rejects(first.text(), error => error?.name === 'AbortError');
    await new Promise(resolve => setTimeout(resolve, 30));

    const changed = {
      ...body,
      input: [
        {
          type: 'image',
          mime_type: 'image/png',
          data: Buffer.from('different image bytes').toString('base64'),
          resolution: 'high'
        },
        { type: 'text', text: RETRY_PROMPT + ' promenjeno' }
      ]
    };
    const retry = await postSolver(
      base,
      endpoint,
      changed,
      'e2e-api-1'
    );
    await retry.text();

    const api2 = await postSolver(
      base,
      endpoint,
      body,
      'e2e-api-2'
    );
    assert.equal(api2.status, 409);

    const assertions = await fetch(
      base +
        '/__harness__/assertions?scenario=retry-after-reload&run=' +
        run
    ).then(item => item.json());
    assert.equal(assertions.ok, false);
    assert.equal(assertions.scenarioChecks.retryPromptIsExact, false);
    assert.equal(assertions.scenarioChecks.retryImageIsByteExact, false);
    assert.equal(assertions.scenarioChecks.noUnexpectedApi2, false);
  });
});
