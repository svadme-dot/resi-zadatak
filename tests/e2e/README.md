# Deterministic math-app E2E harness

This local-only harness serves the real files under docs without changing them.
Before the app starts, it installs an in-memory fetch shim: Gemini Interactions
requests keep the production Stop/abort path, then get redirected to a
same-origin deterministic mock. No request is sent to Google.

The real docs/sw.js is served at its normal /docs/sw.js URL and the harness
does not unregister it, so local browser runs exercise the production service
worker registration and app-shell behavior too. The served copy gets one
in-memory harness-only bypass for /__mock/ and /__harness__/ GETs. This keeps
the production service worker from caching or replaying mock SSE/canonical
responses after the browser shim changes their Google URL to same-origin. The
repository's docs/sw.js is not modified.

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

4. Background create, reload, and reconnect
   - Reset evidence and open Background create, reload, and reconnect.
   - Choose the PNG and send it.
   - Wait until the partial equation 2x = 8 is visible, then reload the same tab.
   - The page bootstrap clears old test state only on the first load, so the
     app's pending interaction record survives this deliberate reload.
   - The app must reconnect to the same interaction. A resumed stream should
     send last_event_id; the sparse interaction.completed event contains no
     final steps, so the app must then canonical-GET the completed resource.
   - Reload/reconnect assertions must have top-level ok true.

5. Stop and server cancellation
   - Reset evidence and open Background partial output, then Stop/cancel.
   - Send the PNG, wait until partial thought/answer text is visible, and press
     Stop.
   - The partial text must remain on screen.
   - Stop/cancel assertions must show one cancel POST, terminal cancelled
     status, retained partial output, and no API 2.

6. Viewer disconnect is not a model failure
   - Reset evidence and open Forced viewer disconnect, same-job reconnect.
   - Send the PNG. The first viewer stream is intentionally dropped after event
     005, while the background interaction remains alive.
   - The app must issue a second stream GET for the same ID with last_event_id,
     then canonical-GET the final resource. It must not create another
     interaction or switch to API 2.
   - Viewer-disconnect assertions must have top-level ok true.

7. Rapid double-send
   - Reset evidence and open Delayed create for rapid double-send.
   - Select the PNG, then click Send twice as quickly as possible.
   - The create response is delayed by 700 ms. Rapid-double-send assertions
     must report exactlyOneCreatePost true.

8. Stop before the create response
   - Reset evidence and open Stop before delayed create returns its ID.
   - Select the PNG, click Send, and immediately click Stop.
   - The app must keep the create request alive, wait for its delayed ID, and
     then POST cancel for exactly that ID.
   - Early-Stop assertions must report one create, one matching cancel, no
     orphan/second create, and no API 2.

9. Ambiguous accepted create
   - Reset evidence and open Accepted create with lost transport outcome.
   - Select the PNG and send it. The mock accepts exactly one background POST
     and creates a hidden job, then drops the connection before returning an
     interaction ID. A fake API 2 is deliberately configured.
   - The app must persist pendingJob.stage as outcome_unknown, show
     #unknownJobActions, and make no automatic retry, API 2 POST, GET, or cancel.
   - Reload the same tab. The warning/actions must remain and the recorded
     request count must still be exactly one. Do not confirm explicit retry
     when validating this invariant.

10. Two-tab global create gate
    - Reset evidence. Open the dashboard's Cross-tab tab A link first, then its
      tab B link. They share origin, localStorage, and run ID; only tab A clears
      old state.
    - Start a send in tab A. Its create response is held for 700 ms. During that
      window, attempt the same or a new send in tab B.
    - Cross-tab assertions require two loaded tab IDs, one create POST total,
      Gemini traffic from only the lease owner, and one canonical finalizer.

11. Lease/fence loss
    - Reset evidence. Open the Fence tab A link and start the PNG solve. Open
      the paired tab B link without clearing shared state.
    - Once partial output is visible, run
      window.__MATH_E2E__.forceFenceLoss() in tab B. This harness-only hook
      changes matematika_background_global_lease_v2 to a higher epoch/fence and
      records which tab performed the takeover.
    - The old owner must abort its viewer, make no second create/API2 request,
      and must not canonical-finalize or clear the shared pending job.

12. PNG image-modality terminal error
    - Reset evidence and open PNG create, then Google image-modality terminal
      error. Upload fixtures/linear-equation.png and send it normally.
    - The mock accepts the background create and returns its ID. Its sparse SSE
      terminal event says failed; canonical GET then returns Google's observed
      errors[] shape with `Image input modality is not enabled for
      models/gemini-3.7-flash-agent`.
    - The request assertion requires the public model name
      gemini-3.7-flash—not the internal `-agent` name—and verifies that decoded
      PNG/JPEG bytes match the declared image MIME type.
    - The injected observer reads the app's persisted model message. Assertions
      pass only if the error text is visible and completionState is interrupted,
      never stopped; no cancel POST and no API 2 are allowed.

The Recorded request JSON view preserves each received body and response
outcome. It records only the synthetic API slot number, never the API-key
header value. Create-request assertions verify:

- model is gemini-3.7-flash
- thinking_level is high
- thinking_summaries is auto
- tools contains exactly one code_execution tool
- no google_search or grounding configuration exists anywhere in the body
- an image MIME type and non-empty base64 payload are present
- background scenarios use background true, store true, and stream false on
  create so the POST returns an Interaction resource containing its ID
- Api-Revision is absent from every browser request; the production GitHub
  Pages CORS path must not depend on that non-safelisted header

The background protocol follows Google's current
[background execution guide](https://ai.google.dev/gemini-api/docs/background-execution)
and
[Interactions API reference](https://ai.google.dev/api/interactions-api-v1):
POST creates the background resource, GET with stream=true and last_event_id
resumes after the last observed event, canonical GET returns the stored
resource, and POST to /interactions/{id}/cancel returns terminal cancelled.
