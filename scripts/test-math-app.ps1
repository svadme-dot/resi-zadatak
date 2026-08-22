$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $repoRoot "src\math-app.html"
$loaderPath = Join-Path $repoRoot "docs\index.html"
$serviceWorkerPath = Join-Path $repoRoot "docs\sw.js"

$source = [IO.File]::ReadAllText($sourcePath, [Text.Encoding]::UTF8)
$loader = [IO.File]::ReadAllText($loaderPath, [Text.Encoding]::UTF8)
$serviceWorker = [IO.File]::ReadAllText($serviceWorkerPath, [Text.Encoding]::UTF8)

function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) {
    throw "STATIC ASSERTION FAILED: $message"
  }
}

function Count-Matches([string]$text, [string]$pattern) {
  return [regex]::Matches($text, $pattern).Count
}

$requestStart = $source.IndexOf("  function buildInteractionRequest")
$requestEnd = $source.IndexOf("  function extractContentText", $requestStart)
Assert-True ($requestStart -ge 0 -and $requestEnd -gt $requestStart) `
  "buildInteractionRequest nije pronađen"
$request = $source.Substring($requestStart, $requestEnd - $requestStart)

Assert-True ($request -match 'model:\s*DEFAULT_MODEL') `
  "glavni zahtev mora koristiti fiksni DEFAULT_MODEL"
Assert-True ((Count-Matches $request 'type:\s*"code_execution"') -eq 1) `
  "glavni zahtev mora imati tačno jedan code_execution alat"
Assert-True ((Count-Matches $request 'thinking_level:\s*"high"') -eq 1) `
  "glavni zahtev mora imati high thinking"
Assert-True ((Count-Matches $request 'thinking_summaries:\s*"auto"') -eq 1) `
  "glavni zahtev mora imati thinking summaries auto tačno jednom"
Assert-True ((Count-Matches $request 'background:\s*true') -eq 1) `
  "glavni zahtev mora pokretati background Interaction"
Assert-True ((Count-Matches $request 'stream:\s*false') -eq 1) `
  "create zahtev ne sme biti viewer stream"
Assert-True ((Count-Matches $request 'store:\s*true') -eq 1) `
  "background Interaction mora ostati stored radi reconnect-a"
Assert-True ($request -notmatch 'google_search|googleSearch|google_search_retrieval') `
  "Google Search grounding ne sme biti u glavnom zahtevu"

Assert-True ((Count-Matches $source 'id="googleModel[1-4]"[^>]*readonly') -eq 4) `
  "sva četiri polja modela moraju biti fiksna/readonly"
Assert-True ($source -match 'model:\s*DEFAULT_MODEL') `
  "profili moraju biti normalizovani na DEFAULT_MODEL"
Assert-True ($source -notmatch 'requestGeneratedChatTitle') `
  "skriveni Gemini zahtev za naslov mora biti uklonjen"
Assert-True ($source -match 'activeViewerController\s*=\s*viewerController') `
  "Stop AbortController mora važiti samo za GET/SSE viewer"
Assert-True ($source -match 'Nema AbortSignal-a: Stop tokom create-a') `
  "create POST ne sme biti abortovan i ostavljen bez ID-a"
Assert-True ($source -match 'cancelRequested:\s*true[\s\S]{0,120}stage:\s*"cancelling"') `
  "Stop mora trajno sačuvati cancelRequested pre mrežnog cancel-a"
Assert-True ($source -match '/\$\{encodeURIComponent\(interactionId\)\}/cancel') `
  "Stop mora koristiti server-side /interactions/{id}/cancel"
Assert-True ($source -match 'completionState:\s*"stopped"') `
  "zaustavljeni parcijalni odgovor mora biti sačuvan"
Assert-True ($source -notmatch 'window\.fetch\s*=|AbortSignal\.timeout') `
  "globalni fetch/timer monkeypatch ne sme postojati u aplikaciji"
Assert-True ($source -notmatch 'google_search|googleSearch|google_search_retrieval') `
  "Google Search grounding ne sme postojati u izvoru"
Assert-True ($source -match '<div class="mobileNavModel">Re.avanje zadataka</div>') `
  "meni mora prikazati novi neutralni podnaslov"

$headersStart = $source.IndexOf("  function interactionHeaders")
$headersEnd = $source.IndexOf("  async function readJsonResponse", $headersStart)
Assert-True ($headersStart -ge 0 -and $headersEnd -gt $headersStart) `
  "interactionHeaders nije pronađen"
$headers = $source.Substring($headersStart, $headersEnd - $headersStart)
Assert-True ($headers -notmatch 'Api-Revision|api-revision') `
  "browser fetch ne sme slati CORS-nepodržan revision header"
Assert-True ($headers -match 'x-goog-api-key') `
  "svaki Interaction fetch mora koristiti x-goog-api-key"

$createStart = $source.IndexOf("  async function createBackgroundInteraction")
$createEnd = $source.IndexOf("  async function getStoredInteraction", $createStart)
Assert-True ($createStart -ge 0 -and $createEnd -gt $createStart) `
  "background create funkcija nije pronađena"
$create = $source.Substring($createStart, $createEnd - $createStart)
Assert-True ($create -match 'method:\s*"POST"') `
  "background create mora biti POST"
Assert-True ($create -notmatch '\bsignal\b') `
  "create POST ne sme imati AbortSignal"
Assert-True ($create -match '\[400, 401, 403, 429\]') `
  "samo strukturisana bezbedna create odbijanja smeju u fallback"
Assert-True ($create -match 'CreateOutcomeUnknownError') `
  "transportna create neizvesnost mora sprečiti duplikat"

$streamStart = $source.IndexOf("  async function streamStoredInteraction")
$streamEnd = $source.IndexOf("  function waitForReconnect", $streamStart)
Assert-True ($streamStart -ge 0 -and $streamEnd -gt $streamStart) `
  "same-ID viewer stream nije pronađen"
$stream = $source.Substring($streamStart, $streamEnd - $streamStart)
Assert-True ($stream -match 'method:\s*"GET"') `
  "viewer reconnect mora biti GET istog Interaction-a"
Assert-True ($stream -match 'query\.set\("last_event_id"') `
  "viewer mora nastaviti od trajno sačuvanog last_event_id"
Assert-True ($stream -match 'event\.event_id\s*\|\|\s*event\.id') `
  "svaki SSE cursor mora biti sačuvan"
Assert-True ($stream -match 'stepTypes:\s*Object\.fromEntries\(stepTypes\)') `
  "stepTypes mora biti u istom checkpoint-u sa event cursorom"
Assert-True ($stream -match 'replaySensitive\s*&&\s*!eventId[\s\S]{0,80}\?\s*true') `
  "SSE delta bez event_id mora prebaciti sledeći reconnect na poll-only"
Assert-True ($stream -match 'interaction\.completed[\s\S]{0,300}completionSignal\s*=\s*true') `
  "SSE completion mora biti samo signal za canonical GET"

$monitorStart = $source.IndexOf("  async function monitorStoredInteraction")
$monitorEnd = $source.IndexOf("  function isErrorHistoryMessage", $monitorStart)
Assert-True ($monitorStart -ge 0 -and $monitorEnd -gt $monitorStart) `
  "same-ID monitor nije pronađen"
$monitor = $source.Substring($monitorStart, $monitorEnd - $monitorStart)
Assert-True ($monitor -notmatch 'createBackgroundInteraction') `
  "viewer/GET prekid nikada ne sme napraviti novi POST"
Assert-True ($monitor -match 'getStoredInteraction\(interactionId, profile\.key\)') `
  "SSE completion mora završiti canonical GET-om istog ID-a"
Assert-True ($monitor -match 'job\.cancelRequested[\s\S]{0,400}cancelStoredInteraction') `
  "persistirani Stop mora imati prednost nad resume streamom"

Assert-True ($source -match 'pendingJob:\s*safePendingJob\(c\.pendingJob\)') `
  "pending job schema mora preživeti loadChats"
Assert-True ($source -match 'findMostRecentPendingChat\(chats\)') `
  "startup mora otvoriti isti pending chat"
Assert-True ($source -match 'window\.addEventListener\("pageshow"') `
  "pageshow mora obnoviti pending job"
Assert-True ($source -match 'document\.addEventListener\("visibilitychange"') `
  "povratak u vidljiv tab mora obnoviti pending job"
Assert-True ($source -match 'window\.addEventListener\("online"') `
  "online događaj mora ponoviti sačuvani cancel/reconnect"
Assert-True ($source -match 'getChatImageBlob\(job\.imageId\)') `
  "fallback posle reload-a mora rekonstruisati originalnu sliku iz IndexedDB"
Assert-True ($source -match 'Date\.now\(\) - liveModel\.totalStartedAtWallClock') `
  "ukupno vreme mora koristiti wall clock preko reload-a"
Assert-True ($source -match 'clientTurnId:\s*terminalTurnId') `
  "terminalna poruka mora imati stabilan turn ID za idempotentni upsert"
Assert-True ($source -match 'GLOBAL_JOB_LEASE_STORAGE\s*=\s*"matematika_background_global_lease_v2"') `
  "svi tabovi moraju deliti jedan app-wide lease"
Assert-True ($source -match 'GLOBAL_JOB_LOCK_NAME\s*=\s*"matematika-background-create-gate-v2"') `
  "create gate mora imati stabilno Web Locks ime"
Assert-True ($source -match 'navigator\.locks\?\.request') `
  "globalni create gate mora koristiti Web Locks kada su dostupni"
Assert-True ($source -match 'ifAvailable:\s*true') `
  "zauzet Web Lock mora fail-fast, ne sme redom pokrenuti kasniji create"
Assert-True ($source -match 'Web Lock ostaje zaklju.an tokom .itavog runner/create/cancel') `
  "Web Lock mora ostati zadržan tokom celog vlasničkog ciklusa"
Assert-True ($source -match 'browser ne podr.ava bezbedni Web Locks create gate') `
  "browser bez atomskog Web Locks mutex-a mora fail-closed"
Assert-True ($source -notmatch '80 \+ Math\.floor\(Math\.random\(\) \* 80\)') `
  "nasumično localStorage čekanje ne sme glumiti atomski create mutex"
Assert-True ($source -match 'ownerTabId[\s\S]{0,180}localJobId[\s\S]{0,180}fenceToken[\s\S]{0,180}epoch[\s\S]{0,180}expiresAt') `
  "durable lease mora imati owner, job, fencing token, epoch i rok"
Assert-True ($source -notmatch 'startJobLeaseHeartbeat|JOB_LEASE_STORAGE_PREFIX') `
  "stari per-job lease kod ne sme ostati"

$renewStart = $source.IndexOf("  function renewJobLease")
$renewEnd = $source.IndexOf("  function releaseJobLease", $renewStart)
Assert-True ($renewStart -ge 0 -and $renewEnd -gt $renewStart) `
  "lease verifier nije pronađen"
$renew = $source.Substring($renewStart, $renewEnd - $renewStart)
Assert-True ($renew -notmatch 'localStorage\.(?:setItem|removeItem)') `
  "heartbeat ne sme menjati lease van već zadržanog Web Lock-a"
Assert-True ($source -match 'localPersistenceHealthy\s*=\s*false') `
  "localStorage neuspeh mora trajno upozoriti da recovery nije zaštićen"

$pagehideStart = $source.IndexOf('  window.addEventListener("pagehide"')
$pagehideEnd = $source.IndexOf('  window.addEventListener("pageshow"', $pagehideStart)
Assert-True ($pagehideStart -ge 0 -and $pagehideEnd -gt $pagehideStart) `
  "pagehide lifecycle blok nije pronađen"
$pagehide = $source.Substring($pagehideStart, $pagehideEnd - $pagehideStart)
Assert-True ($pagehide -match 'markJobOwnershipLost') `
  "pagehide mora ograditi stari async runner"
Assert-True ($pagehide -notmatch 'releaseJobLease') `
  "pagehide ne sme koristiti normalni release koji resetuje lost fence"
Assert-True ($pagehide -match 'abandonJobLeaseForPagehide') `
  "pagehide mora odmah osloboditi lifetime Web Lock uz trajni lost fence"

$abandonStart = $source.IndexOf("  function abandonJobLeaseForPagehide")
$abandonEnd = $source.IndexOf("  function checkpointActivePendingJob", $abandonStart)
Assert-True ($abandonStart -ge 0 -and $abandonEnd -gt $abandonStart) `
  "pagehide abandon helper nije pronađen"
$abandon = $source.Substring($abandonStart, $abandonEnd - $abandonStart)
Assert-True ($abandon -match 'activeJobLeaseLost\s*=\s*true') `
  "BFCache abandon mora zadržati lost=true za stari promise"
Assert-True ($abandon -match 'releaseWebLock\?\.\(\)') `
  "BFCache abandon mora razrešiti lifetime Web Lock"

$runnerStart = $source.IndexOf("  function launchPendingJobRunner")
$runnerEnd = $source.IndexOf("  function resumePendingSolveIfNeeded", $runnerStart)
Assert-True ($runnerStart -ge 0 -and $runnerEnd -gt $runnerStart) `
  "pending runner nije pronađen"
$runner = $source.Substring($runnerStart, $runnerEnd - $runnerStart)
Assert-True ($runner -match 'CreateOutcomeUnknownError[\s\S]{0,160}preserveOutcomeUnknown') `
  "ambiguous create mora ostati trajno unresolved, bez generic finalizacije"
Assert-True ($runner -match 'LeaseLostError[\s\S]{0,120}ownership_lost') `
  "gubitak fence-a mora zaustaviti runner bez terminalnog upisa"
Assert-True ($source -match 'stage:\s*"outcome_unknown"') `
  "ambiguous create mora imati durable outcome_unknown stanje"
$retryStart = $source.IndexOf("  async function retryUnresolvedJobExplicitly")
$retryEnd = $source.IndexOf("  async function discardUnresolvedJobExplicitly", $retryStart)
Assert-True ($retryStart -ge 0 -and $retryEnd -gt $retryStart) `
  "eksplicitni unresolved retry handler nije pronađen"
$retry = $source.Substring($retryStart, $retryEnd - $retryStart)
Assert-True ($retry -match 'confirm\(warning\)') `
  "novi create posle nepoznatog ishoda mora zahtevati eksplicitnu potvrdu"
Assert-True ($source -match 'interaction\.errors') `
  "terminalni Interaction errors[] mora biti obrađen"
Assert-True ($source -match 'keyFingerprint:\s*apiKeyFingerprint') `
  "pending job mora čuvati ne-secret fingerprint originalnog ključa"
Assert-True ($source -match 'freshBeforeFallback\.cancelRequested') `
  "terminalni fallback mora ponovo proveriti Stop posle image await-a"
Assert-True ($source -match '!getActivePendingJob\(\) && !activeJobLeaseId[\s\S]{0,240}userStopRequested\s*=\s*true') `
  "Stop pre lease/pending zapisa mora sačuvati lokalnu pre-dispatch nameru"
Assert-True ($source -match 'ownsLease\s*=\s*await claimGlobalJobOwnership[\s\S]{0,240}if \(userStopRequested\)') `
  "send mora proveriti rani Stop odmah posle globalnog claim await-a"
Assert-True ($source -match 'job\.stage === "waiting_create_credentials"[\s\S]{0,800}unknownRetryJob\.hidden\s*=\s*false') `
  "pre-dispatch credential stanje mora nuditi eksplicitni safe rebind"
Assert-True ($source -match 'job\.stage === "waiting_credentials"[\s\S]{0,800}unknownRetryJob\.hidden\s*=\s*true') `
  "known-ID credential stanje mora nuditi izlaz iz blokiranog pending-a"
Assert-True ($source -match 'focusGlobalPendingJob\(\)[\s\S]{0,80}if \(busy\) return') `
  "send mora konsultovati globalni pending zapis pre novog turn-a"

$sendStart = $source.IndexOf("  async function send()")
$sendEnd = $source.IndexOf('  el("saveKey")', $sendStart)
Assert-True ($sendStart -ge 0 -and $sendEnd -gt $sendStart) `
  "send funkcija nije pronađena"
$send = $source.Substring($sendStart, $sendEnd - $sendStart)
Assert-True ($send.IndexOf("setSolveBusyUi(true)") -lt $send.IndexOf("await saveChatImage")) `
  "turn lock mora nastati pre prvog image await-a"
Assert-True ($send -match 'localJobId:\s*clientTurnId') `
  "pending posao mora koristiti stabilan clientTurnId"
Assert-True ($source -match 'buildInteractionRequest\([\s\S]{0,240}job\.localJobId') `
  "stateless context mora izostaviti trenutni client turn umesto dupliranja prompta"

Assert-True ($loader -notmatch 'window\.fetch\s*=|AbortSignal\.timeout|realSetTimeout') `
  "loader više ne sme sadržati Stop monkeypatch"
Assert-True ((Count-Matches $loader 'app-v5/part-[^''"]+\.txt\?v=9') -eq 9) `
  "loader mora koristiti svih 9 chunk URL-ova sa v=9"
Assert-True ($serviceWorker -match 'CACHE_NAME\s*=\s*"matematika-pwa-v15"') `
  "service worker cache mora biti v15"
Assert-True ((Count-Matches $serviceWorker 'app-v5/part-[^''"]+\.txt\?v=9') -eq 9) `
  "service worker mora keširati svih 9 chunk URL-ova sa v=9"

& (Join-Path $PSScriptRoot "build-math-app.ps1") -CheckOnly | Out-Null
Write-Output "Sve statičke provere matematičke aplikacije su prošle."
