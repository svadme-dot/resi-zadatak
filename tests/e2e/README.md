# Deterministic math-app E2E harness

This local-only harness serves the real files under docs without changing them.
Before the app starts, it installs an in-memory fetch shim: Gemini Interactions
requests keep the production Stop/abort path, then get redirected to a
same-origin deterministic mock. No request is sent to Google.

## Start

From the workspace root:

    node tests/e2e/harness-server.mjs

Open the printed dashboard, normally:

    http://127.0.0.1:4173/__harness__/

The server has no package dependencies. To verify the harness itself:

    node --test tests/e2e/harness-server.test.mjs

## Browser runs

Use tests/e2e/fixtures/linear-equation.png whenever the app asks for a gallery
image. It is a real PNG so createImageBitmap works reliably in Chromium. The
bootstrap supplies fake local API slots automatically. The PNG is reproducible:

    node tests/e2e/fixtures/generate-linear-equation-png.mjs

1. Success stream
   - Reset evidence from the dashboard.
   - Open Success stream.
   - Choose the synthetic image, send it, and watch the thought summary appear
     before the final answer.
   - Open Success assertions. The top-level ok value must be true.

2. Stop during a slow stream
   - Reset evidence and open Slow stream for Stop.
   - Choose the synthetic image and send it.
   - Wait until part of the final answer is visible, then press Stop.
   - Confirm the already-rendered thought/answer remains visible.
   - Open Stop/abort assertions. The top-level ok value must be true.

3. API fallback
   - Reset evidence and open API 1 returns 429, API 2 succeeds.
   - Choose the synthetic image and send it.
   - API 1 deterministically returns 429 for all of its same-slot retries; API 2
     then streams the successful answer.
   - Open Fallback assertions. The top-level ok value must be true, including
     api1Returned429, api2Completed, and api1WasBeforeApi2.

The Recorded request JSON view preserves each received body and response
outcome. Solver assertions verify:

- model is gemini-3.6-flash
- thinking_level is high
- thinking_summaries is auto
- tools contains exactly one code_execution tool
- no google_search or grounding configuration exists anywhere in the body
- an image MIME type and non-empty base64 payload are present
