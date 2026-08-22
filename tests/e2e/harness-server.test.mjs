import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarnessServer } from './harness-server.mjs';

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
