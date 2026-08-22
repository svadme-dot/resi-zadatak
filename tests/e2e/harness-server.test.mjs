import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createHarnessServer } from './harness-server.mjs';

const RETRY_PROMPT =
  'E2E ponovni pokušaj: reši jednačinu 2x + 3 = 11.';

const validSolverBody = {
  model: 'gemini-3.6-flash',
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
        data: png.toString('base64')
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
          data: Buffer.from('different image bytes').toString('base64')
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
