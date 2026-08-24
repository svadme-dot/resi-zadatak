$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $repoRoot "src\math-app.html"
$loaderPath = Join-Path $repoRoot "docs\index.html"
$serviceWorkerPath = Join-Path $repoRoot "docs\sw.js"
$manifestPath = Join-Path $repoRoot "docs\manifest.webmanifest"

$source = [IO.File]::ReadAllText($sourcePath, [Text.Encoding]::UTF8)
$loader = [IO.File]::ReadAllText($loaderPath, [Text.Encoding]::UTF8)
$serviceWorker = [IO.File]::ReadAllText($serviceWorkerPath, [Text.Encoding]::UTF8)
$manifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8)

function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) {
    throw "STATIC ASSERTION FAILED: $message"
  }
}

function Count-Matches([string]$text, [string]$pattern) {
  return [regex]::Matches($text, $pattern).Count
}

$requestStart = $source.IndexOf("  function buildInteractionRequest")
$requestEnd = $source.IndexOf("  function buildLocalInteractionRequest", $requestStart)
Assert-True ($requestStart -ge 0 -and $requestEnd -gt $requestStart) `
  "buildInteractionRequest nije pronađen"
$request = $source.Substring($requestStart, $requestEnd - $requestStart)

$inputStart = $source.IndexOf("  function buildInteractionInput")
$inputEnd = $source.IndexOf("  function buildInteractionRequest", $inputStart)
Assert-True ($inputStart -ge 0 -and $inputEnd -gt $inputStart) `
  "buildInteractionInput nije pronadjen"
$interactionInput = $source.Substring($inputStart, $inputEnd - $inputStart)

$keyOverlayStart = $source.IndexOf('<div id="keyOverlay"')
$keyOverlayEnd = $source.IndexOf("<script>", $keyOverlayStart)
Assert-True ($keyOverlayStart -ge 0 -and $keyOverlayEnd -gt $keyOverlayStart) `
  "keyOverlay za opcione lokalne API kljuceve nije pronađen"
$keyOverlay = $source.Substring(
  $keyOverlayStart,
  $keyOverlayEnd - $keyOverlayStart
)
$sourceOutsideKeyOverlay = $source.Remove(
  $keyOverlayStart,
  $keyOverlayEnd - $keyOverlayStart
)

$localBuilderStart = $source.IndexOf("  function buildLocalInteractionRequest")
$localBuilderEnd = $source.IndexOf("  function extractContentText", $localBuilderStart)
Assert-True ($localBuilderStart -ge 0 -and $localBuilderEnd -gt $localBuilderStart) `
  "buildLocalInteractionRequest nije pronađen"
$localBuilder = $source.Substring(
  $localBuilderStart,
  $localBuilderEnd - $localBuilderStart
)
$sourceOutsideLocalBuilder = $source.Remove(
  $localBuilderStart,
  $localBuilderEnd - $localBuilderStart
)

$gatewayFetchStart = $source.IndexOf("  async function fetchGatewayResponse")
$gatewayFetchEnd = $source.IndexOf("  async function fetchTransportResponse", $gatewayFetchStart)
Assert-True ($gatewayFetchStart -ge 0 -and $gatewayFetchEnd -gt $gatewayFetchStart) `
  "fetchGatewayResponse nije pronađen"
$gatewayFetch = $source.Substring(
  $gatewayFetchStart,
  $gatewayFetchEnd - $gatewayFetchStart
)

$transportFetchStart = $gatewayFetchEnd
$transportFetchEnd = $source.IndexOf("  async function throwIfInteractionHttpError", $transportFetchStart)
Assert-True ($transportFetchEnd -gt $transportFetchStart) `
  "fetchTransportResponse nije pronađen"
$transportFetch = $source.Substring(
  $transportFetchStart,
  $transportFetchEnd - $transportFetchStart
)

$httpErrorStart = $transportFetchEnd
$httpErrorEnd = $source.IndexOf("  async function fetchInteraction", $httpErrorStart)
Assert-True ($httpErrorEnd -gt $httpErrorStart) `
  "throwIfInteractionHttpError nije pronađen"
$httpErrorClassifier = $source.Substring(
  $httpErrorStart,
  $httpErrorEnd - $httpErrorStart
)

$streamStart = $source.IndexOf("  async function streamInteraction")
$streamEnd = $source.IndexOf("  async function requestInteractionOnce", $streamStart)
Assert-True ($streamStart -ge 0 -and $streamEnd -gt $streamStart) `
  "streamInteraction nije pronađen"
$streamInteraction = $source.Substring(
  $streamStart,
  $streamEnd - $streamStart
)

$localLimiterStart = $source.IndexOf("  function localApiBucketId")
$localLimiterEnd = $source.IndexOf("  function makeGatewayUnavailableError", $localLimiterStart)
Assert-True ($localLimiterStart -ge 0 -and $localLimiterEnd -gt $localLimiterStart) `
  "lokalni rolling limiter nije pronađen"
$localLimiter = $source.Substring(
  $localLimiterStart,
  $localLimiterEnd - $localLimiterStart
)

$profileSelectionStart = $source.IndexOf("  function getApiProfiles()")
$profileSelectionEnd = $source.IndexOf("  function apiProfileId", $profileSelectionStart)
Assert-True ($profileSelectionStart -ge 0 -and $profileSelectionEnd -gt $profileSelectionStart) `
  "local-first izbor API profila nije pronađen"
$profileSelection = $source.Substring(
  $profileSelectionStart,
  $profileSelectionEnd - $profileSelectionStart
)

$solveProfilesStart = $source.IndexOf("      const phaseProfiles = profiles;")
$solveProfilesEnd = $source.IndexOf("      if (!solved) {", $solveProfilesStart)
Assert-True ($solveProfilesStart -ge 0 -and $solveProfilesEnd -gt $solveProfilesStart) `
  "jednofazni local/gateway solve tok nije pronađen"
$solveProfiles = $source.Substring(
  $solveProfilesStart,
  $solveProfilesEnd - $solveProfilesStart
)

$parserStart = $source.IndexOf("  function parseLocalApiKeyText")
$parserEnd = $source.IndexOf("  function normalizeLocalApiProfile", $parserStart)
Assert-True ($parserStart -ge 0 -and $parserEnd -gt $parserStart) `
  "parser lokalnog API key fajla nije pronađen"
$localFileParser = $source.Substring($parserStart, $parserEnd - $parserStart)

$importStart = $source.IndexOf("  async function importLocalApiKeyFile")
$importEnd = $source.IndexOf("  function populateLocalApiDialog", $importStart)
Assert-True ($importStart -ge 0 -and $importEnd -gt $importStart) `
  "lokalni file importer nije pronađen"
$localFileImporter = $source.Substring($importStart, $importEnd - $importStart)

$importHandlerStart = $source.IndexOf('  el("importLocalKeys").addEventListener')
$importHandlerEnd = $source.IndexOf('  el("saveLocalKeys").addEventListener', $importHandlerStart)
Assert-True ($importHandlerStart -ge 0 -and $importHandlerEnd -gt $importHandlerStart) `
  "UI handler za lokalni file import nije pronađen"
$localFileImportHandler = $source.Substring(
  $importHandlerStart,
  $importHandlerEnd - $importHandlerStart
)

Assert-True ($source -match '<div class="mobileNavModel">Re.avanje zadataka</div>') `
  "bocni meni mora prikazivati trazeni podnaslov"

Assert-True ((Count-Matches $keyOverlay '<input\b[^>]*\btype="password"') -eq 4) `
  "keyOverlay mora imati tačno četiri maskirana lokalna API polja"
Assert-True ((Count-Matches $keyOverlay 'id="localKey[1-4]"') -eq 4) `
  "lokalna API polja moraju biti slotovi 1, 2, 3 i 4"
Assert-True ((Count-Matches $source '<input\b[^>]*\btype="password"') -eq 4) `
  "van keyOverlay-a ne sme postojati dodatno polje za API ključ"
Assert-True ((Count-Matches $keyOverlay 'autocomplete="off"\s+autocapitalize="none"') -eq 4) `
  "API ključevi ne smeju tražiti password-manager sinhronizaciju ili autocapitalization"
Assert-True ($keyOverlay -match '(?i)Gemini\s+3\.6\s+Flash') `
  "naziv provajdera/modela sme biti prikazan u sekciji za API ključeve"
Assert-True ($sourceOutsideKeyOverlay -notmatch '(?i)\bgemini\b') `
  "naziv provajdera/modela ne sme biti korisniku vidljiv van keyOverlay-a"
Assert-True ($source -match 'const\s+API_GATEWAY_URL\s*=') `
  "frontend mora koristiti server-side API gateway"
Assert-True ($source -match 'const\s+API_SLOT_ORDER\s*=\s*Object\.freeze\(\[1,\s*2,\s*3,\s*4\]\)') `
  "redosled API slotova mora ostati 1, 2, 3, 4"
Assert-True ($profileSelection -match 'const\s+localProfiles\s*=\s*getConfiguredLocalApiProfiles\(\)[\s\S]{0,100}if\s*\(localProfiles\.length\)\s*return\s+localProfiles') `
  "bar jedan lokalni ključ mora izabrati samo lokalne profile"
Assert-True ($profileSelection -match 'return\s+API_SLOT_ORDER\.map\(slot\s*=>\s*\(\{[\s\S]{0,100}transport:\s*"gateway"[\s\S]{0,80}\bslot\b') `
  "tek nula lokalnih ključeva mora izabrati neutralne gateway slotove 1-4"
Assert-True ($source -match '"X-Math-Api-Slot":\s*String\(profile\.slot\)') `
  "gateway zahtev mora slati samo neutralni broj API slota"
Assert-True ($gatewayFetch -notmatch 'x-goog-api-key|profile\.key|LOCAL_UPSTREAM') `
  "gateway zahtev nikada ne sme dobiti lokalni ključ ili direktni upstream URL"
Assert-True ((Count-Matches $source '"x-goog-api-key":\s*profile\.key') -eq 1) `
  "lokalni ključ sme postojati samo u jednom direktnom fallback headeru"
Assert-True ($transportFetch -match 'profile\.transport\s*===\s*"local"[\s\S]{0,520}"x-goog-api-key":\s*profile\.key') `
  "direktan credential header mora biti ograničen na lokalnu transport fazu"
Assert-True ($request -notmatch '\bmodel\s*:|system_instruction\s*:|generation_config\s*:|tools\s*:') `
  "javni gateway body ne sme slati model, prompt, alate ili thinking konfiguraciju"
Assert-True ($localBuilder -match 'model:\s*LOCAL_UPSTREAM_MODEL') `
  "lokalni builder mora fiksirati isti model"
Assert-True ($localBuilder -match 'system_instruction:\s*SYSTEM_INSTRUCTION') `
  "lokalni builder mora fiksirati isti system prompt"
Assert-True ($localBuilder -match 'tools:\s*\[\{\s*type:\s*"code_execution"\s*\}\]') `
  "lokalni builder mora zadržati code_execution"
Assert-True ($localBuilder -match 'thinking_level:\s*"high"') `
  "lokalni builder mora zadržati high thinking"
Assert-True ($localBuilder -match 'thinking_summaries:\s*"auto"') `
  "lokalni builder mora zadržati automatske thinking sažetke"
Assert-True ($sourceOutsideLocalBuilder -notmatch '\bmodel\s*:|system_instruction\s*:|generation_config\s*:|thinking_level\s*:|thinking_summaries\s*:|tools\s*:') `
  "fiksna provider/model konfiguracija sme postojati samo u lokalnom builderu"
Assert-True ($interactionInput -match 'resolution:\s*IMAGE_MEDIA_RESOLUTION') `
  "svaka slika mora traziti high media resolution"
Assert-True ($source -match 'const\s+IMAGE_MEDIA_RESOLUTION\s*=\s*"high"') `
  "Interactions media resolution mora biti high"
Assert-True ($source -match 'const\s+MAX_API_IMAGE_BYTES\s*=\s*1536\s*\*\s*1024') `
  "frontend mora zadržati sliku ispod bezbednog Worker/Free CPU plafona"
Assert-True ($source -match '\[1800,\s*0\.9\][\s\S]{0,1200}blob\.size\s*<=\s*MAX_API_IMAGE_BYTES') `
  "obrada slike mora prvo sačuvati postojeći 1800px/0.9 kvalitet, pa adaptivno smanjiti samo preveliku sliku"
Assert-True ($request -notmatch 'google_search|googleSearch|google_search_retrieval') `
  "Google Search grounding ne sme biti u glavnom zahtevu"
Assert-True ($request -notmatch 'background\s*:\s*true') `
  "background režim još ne sme biti uključen"

Assert-True ($source -match 'const\s+LOCAL_FALLBACK_STORAGE\s*=\s*\r?\n\s*"matematika_local_api_fallback_v1"') `
  "opciona lokalna rezerva mora imati sopstveni neutralni storage"
Assert-True ($source -match 'function\s+getConfiguredLocalApiProfiles\s*\(\)[\s\S]{0,160}filter\(profile\s*=>\s*profile\.key\)') `
  "prazni lokalni slotovi moraju biti opcioni i preskočeni"
Assert-True ($source -match '"Lokalni klju.evi su uklonjeni; koristi se Cloudflare\."') `
  "čuvanje sva četiri prazna polja mora vratiti Cloudflare režim"
Assert-True ($source -notmatch 'Unesi bar jedan[^\r\n]*API ključ') `
  "lokalni ključevi moraju ostati potpuno opcioni"
Assert-True ($keyOverlay -match '<input\s+id="localKeysFile"\s+type="file"\s+accept="\.txt,text/plain"\s+hidden>') `
  "keyOverlay mora imati skriveni lokalni .txt file picker"
Assert-True ($keyOverlay -match 'id="importLocalKeys"[\s\S]{0,100}Uvezi i sa.uvaj api_keys\.txt') `
  "keyOverlay mora nuditi eksplicitan lokalni api_keys.txt import"
Assert-True ($source -match 'const\s+MAX_LOCAL_API_FILE_BYTES\s*=\s*16\s*\*\s*1024') `
  "lokalni API fajl mora imati mali fiksni size limit"
Assert-True ($localFileParser -match 'replace\(/\^\\uFEFF/' -and $localFileParser -match 'split\(/\\r\\n\|\\n\|\\r/' -and $localFileParser -match 'keys\.length\s*>\s*API_SLOT_ORDER\.length') `
  "parser mora podržati BOM/CRLF/prazne redove i odbiti više od četiri ključa"
Assert-True ($localFileParser -match 'key\.length\s*<\s*8[\s\S]{0,180}\[\\s\\u0000-\\u001f\\u007f\]') `
  "parser mora odbiti neispravan red bez ispisivanja vrednosti ključa"
Assert-True ($localFileImporter -match 'parseLocalApiKeyText\(await\s+file\.text\(\)\)[\s\S]{0,420}key:\s*keys\[index\]\s*\|\|\s*""[\s\S]{0,180}applyLocalApiProfiles\(profiles\)') `
  "import mora lokalno pročitati fajl, isprazniti višak slotova i odmah koristiti zajednički save put"
Assert-True ($localFileImporter -notmatch 'fetch\s*\(|XMLHttpRequest|sendBeacon|FormData|console\.') `
  "uvoz fajla nikada ne sme slati ili logovati njegov sadržaj"
Assert-True ((Count-Matches $localFileImportHandler 'localKeysFileInput\.value\s*=\s*""') -ge 2) `
  "file input mora biti resetovan pre i posle uvoza radi ponovnog izbora istog fajla"
Assert-True ((Count-Matches $source 'applyLocalApiProfiles\(profiles\)') -eq 3) `
  "ručni Save i file import moraju deliti isti credential/interaction invalidation put"
Assert-True ($source -match 'localStorage\.getItem\(LEGACY_PROFILES_STORAGE\)[\s\S]{0,760}localStorage\.getItem\(LEGACY_KEY_STORAGE\)[\s\S]{0,360}saveLocalApiProfiles\(migrated\)[\s\S]{0,180}localStorage\.removeItem\(LEGACY_KEY_STORAGE\)[\s\S]{0,120}localStorage\.removeItem\(LEGACY_PROFILES_STORAGE\)') `
  "stari lokalni ključevi moraju se prvo migrirati, pa tek onda ukloniti iz legacy storage-a"
Assert-True ($source -match 'function\s+apiProfileId\s*\(profile\)[\s\S]{0,180}profile\.transport\s*===\s*"local"[\s\S]{0,120}localApiBucketId\(profile\.key\)[\s\S]{0,100}`gateway:\$\{profile\.slot\}`') `
  "lokalni interaction ID mora razlikovati transport, slot i konkretan ključ"
Assert-True ($source -match 'previousInteractionProfileId\.startsWith\("local:"\)[\s\S]{0,100}saveCurrentInteractionId\("",\s*""\)') `
  "promena lokalnih ključeva mora poništiti lokalni previous interaction ID"

Assert-True ($source -match 'const\s+API_GATEWAY_MARKER_HEADER\s*=\s*"X-Math-Gateway"') `
  "frontend mora proveravati neutralni marker sopstvenog gateway-a"
Assert-True ($source -match 'function\s+gatewayHealthUrl\s*\(') `
  "mora postojati zaseban gateway health URL"
Assert-True ($source -match 'async\s+function\s+gatewayHealthIsAvailable\s*\([\s\S]{0,900}cache:\s*"no-store"[\s\S]{0,240}response\.headers\.get\(API_GATEWAY_MARKER_HEADER\)\s*===\s*"1"') `
  "health probe mora biti no-store i prihvatiti samo označen gateway odgovor"
Assert-True ($gatewayFetch -match 'catch\s*\(err\)[\s\S]{0,260}gatewayHealthIsAvailable\(signal\)[\s\S]{0,240}!gatewayHealthy\s*&&\s*navigator\.onLine\s*!==\s*false[\s\S]{0,180}makeGatewayUnavailableError') `
  "početni mrežni kvar sme preći u infrastrukturalni fallback tek posle neuspešnog health probe-a"
Assert-True ($gatewayFetch -match 'response\.headers\.get\(API_GATEWAY_MARKER_HEADER\)\s*!==\s*"1"[\s\S]{0,220}makeGatewayUnavailableError') `
  "neoznačen deployment/platform odgovor mora se klasifikovati kao gateway kvar"
Assert-True ($httpErrorClassifier -match '\["not_found",\s*"rate_control_unavailable"\]\.includes\(code\)[\s\S]{0,100}gatewayInfrastructureFailure\s*=\s*true') `
  "samo dokazano pre-upstream Worker stanje sme postati označen infrastrukturalni kvar"
Assert-True ($solveProfiles -match 'const\s+phaseProfiles\s*=\s*profiles') `
  "send mora zamrznuti samo jedan prethodno izabran local ili gateway profilni niz"
Assert-True ($solveProfiles -notmatch 'getConfiguredLocalApiProfiles|getApiProfiles|phase\s*=') `
  "solve ne sme menjati transport nakon početnog local-first izbora"
Assert-True ($solveProfiles -match 'err\?\.gatewayTransportFailure\s*\|\|[\s\S]{0,100}err\?\.gatewayInfrastructureFailure[\s\S]{0,100}throw\s+err') `
  "gateway transportni/infrastrukturni kvar mora stati bez prelaska na lokalni niz"
Assert-True ($source -notmatch 'gatewayResponseReceivedDuringSolve') `
  "stari gateway-u-local cross-transport state više ne sme postojati"
Assert-True ($source -match 'profiles\s*=\s*getApiProfiles\(\)') `
  "svaki Send mora jednom izabrati local-first ili gateway-only profile"
Assert-True ($solveProfiles -match 'err\?\.gatewayTransportFailure[\s\S]{0,160}throw\s+err') `
  "transportni prekid posle gateway odgovora ne sme fan-outovati druge slotove"
Assert-True ($streamInteraction -match 'reader\.read\(\)[\s\S]{0,260}catch\s*\(err\)[\s\S]{0,180}err\.gatewayTransportFailure\s*=\s*true') `
  "reader prekid označenog gateway streama mora postaviti transportni marker"
Assert-True ($streamInteraction -match 'type\s*===\s*"error"[\s\S]{0,900}numericStatus\s*===\s*502[\s\S]{0,80}"UNAVAILABLE"[\s\S]{0,220}numericStatus\s*===\s*504[\s\S]{0,100}"DEADLINE_EXCEEDED"[\s\S]{0,260}err\.gatewayTransportFailure\s*=\s*true') `
  "gateway SSE 502/504 transportni završetak mora postaviti transportni marker"
Assert-True ($source -match 'function\s+isStalePreviousInteractionError\s*\([\s\S]{0,240}!err\?\.gatewayTransportFailure') `
  "gateway transportni prekid ne sme izgledati kao istekli interaction ID"
Assert-True ((Count-Matches $source 'isRetriableDemandError\(err\)\s*&&\s*\r?\n\s*!err\?\.gatewayInfrastructureFailure\s*&&\s*\r?\n\s*!err\?\.gatewayTransportFailure') -eq 2) `
  "gateway transportni prekid ne sme pokrenuti nijedan isti-slot retry"
Assert-True ($source -match 'previousInteractionProfileId\s*===\s*profileId') `
  "previous interaction ID sme se koristiti samo sa istim namespaced profilom"
Assert-True ($source -match 'rate_control_unavailable[\s\S]{0,80}return false') `
  "greška rate koordinatora ne sme fan-outovati zahtev kroz ostale gateway slotove"

Assert-True ($localLimiter -match 'const\s+cutoff\s*=\s*now\s*-\s*60_000') `
  "lokalni limiter mora koristiti rolling prozor od tačno 60 sekundi"
Assert-True ($localLimiter -match 'timestamp\s*>=\s*cutoff') `
  "timestamp tačno na granici od 60 sekundi mora ostati uračunat"
Assert-True ($localLimiter -match 'const\s+bucket\s*=\s*localApiBucketId\(profile\.key\)') `
  "lokalni limiter mora grupisati po ključu, ne samo po slotu"
Assert-True ($localLimiter -match 'function\s+mergeLocalRateTimestamps[\s\S]{0,900}Math\.max\([\s\S]{0,180}for\s*\(let\s+i\s*=\s*0;\s*i\s*<\s*repeats') `
  "memory/storage merge mora sačuvati multiplicitet više rezervacija u istom milisekundu"
Assert-True ($localLimiter -match 'timestamps\.length\s*>=\s*10') `
  "jedanaesti lokalni pokušaj u rolling prozoru mora biti odbijen"
Assert-True ($localLimiter -match 'timestamps\.push\(now\)[\s\S]{0,220}localStorage\.setItem\(LOCAL_RATE_STORAGE') `
  "lokalna rezervacija mora biti upisana pre mrežnog pokušaja i ne sme se vraćati"
Assert-True ($localLimiter -match 'navigator\.locks\?\.request[\s\S]{0,180}\{\s*mode:\s*"exclusive",\s*signal\s*\}') `
  "više tabova mora best-effort serijalizovati lokalni rolling limiter"
Assert-True ($transportFetch -match 'profile\.transport\s*===\s*"local"[\s\S]{0,100}await\s+reserveLocalApiAttempt\(profile,\s*signal\)[\s\S]{0,100}return\s+fetch\(') `
  "svaki direktni lokalni poziv mora rezervisati limit pre fetch-a"
Assert-True ($source -match '"local_slot_rate_limited"[\s\S]{0,180}!isModelCapabilityFallbackError') `
  "lokalno popunjen limiter ne sme pokretati isti-slot retry"

Assert-True ($source -notmatch 'requestGeneratedChatTitle') `
  "skriveni AI zahtev za naslov mora biti uklonjen"
Assert-True ($source -match 'activeSolveController\s*=\s*new AbortController') `
  "Stop mora koristiti eksplicitni solve AbortController"
Assert-True ($source -match 'isUserStopError\(err, solveSignal\)') `
  "send mora posebno obraditi korisnički Stop"
Assert-True ($source -match 'function\s+hasVisibleLiveAnswer\s*\(') `
  "fallback mora razlikovati thinking od stvarno zapocetog odgovora"
Assert-True ($source -match 'function\s+canUseNextApiProfile\s*\(err\)[\s\S]{0,620}isRetriableDemandError\(err\)\s*&&\s*\r?\n\s*!hasVisibleLiveAnswer\(\)') `
  "high-demand sme da odbaci samo thinking bez finalnog odgovora"
Assert-True ($source -match 'const\s+canUseNextProfile\s*=\s*canUseNextApiProfile\(err\)') `
  "send mora koristiti thinking-aware profil fallback odluku"
Assert-True ($source -match '"slot_rate_limited",\s*\r?\n\s*"slot_unavailable",\s*\r?\n\s*"local_slot_rate_limited"') `
  "popunjen ili nekonfigurisan slot mora odmah preći dalje bez istog-slot retry-ja"
Assert-True ((Count-Matches $source 'isStalePreviousInteractionError\(err\)\s*&&\s*!hasVisibleLiveOutput\(\)') -eq 2) `
  "stari interaction ID sme da se ponovi samo bez vidljivog parcijalnog izlaza"
Assert-True ($source -match 'function\s+isModelCapabilityFallbackError\s*\(') `
  "model/modality greska mora imati usku fallback klasifikaciju"
Assert-True ($source -match 'image input modality is not enabled') `
  "poznata agent image-modality greska mora biti prepoznata"
Assert-True ($source -match 'function\s+throwIfTerminalInteractionFailed\s*\(') `
  "autoritativni terminalni neuspeh ne sme pokretati dupli sync zahtev"
Assert-True ($source -match 'let\s+parsed;[\s\S]{0,220}processEvent\(parsed\);') `
  "SSE parser mora propustiti processEvent gresku van JSON parse catch-a"
Assert-True ($source -match 'err\.code\s*=\s*event\?\.error\?\.code[\s\S]{0,220}err\.status\s*=\s*numericStatus') `
  "lokalna SSE numeric 401/429 greška mora pokrenuti postojeći key fallback"
Assert-True ($source -match 'completionState:\s*"stopped"') `
  "zaustavljeni parcijalni odgovor mora biti sačuvan"
Assert-True ($source -match 'saveCurrentInteractionId\("",\s*""\)') `
  "prekinuti turn mora očistiti stari server-side interaction ID"
Assert-True ($source -match 'function\s+startNewChat\(focusPrompt\s*=\s*true\)') `
  "novi chat mora imati usko kontrolisan fokus composera"
Assert-True ((Count-Matches $source 'startNewChat\(false\);\s*\r?\n\s*openSourceSheet\(\);') -eq 2) `
  "oba Reši zadatak ulaza moraju otvoriti izbor bez fokusiranja textarea polja"
Assert-True ($source -match 'function\s+openSourceSheet\(\)[\s\S]{0,260}active\.blur\(\)') `
  "izbor kamere/galerije mora ukloniti postojeći tekstualni fokus"
Assert-True ($source -match 'el\("sourceTextOnly"\)\.addEventListener\("click",\s*\(\)\s*=>\s*\{\s*closeSourceSheet\(\);\s*promptEl\.focus\(\);') `
  "nastavak bez fotografije mora zadržati normalan fokus tekstualnog unosa"
Assert-True ($source -match 'role\.textContent\s*=\s*"AI asistent"') `
  "odgovor mora imati neutralnu korisničku oznaku"
Assert-True ($source -match 'markdownToHtml\(sanitizeServiceMessage\(text\),\s*final\)') `
  "svaki prikaz serverskog odgovora mora neutralisati naziv provajdera/modela"
Assert-True ($source -match 'function\s+extractMarkdownCodeBlocksForRender\s*\([^)]*final\s*=\s*false') `
  "renderer mora imati jedan linearni parser za fenced i uvučeni kod"
Assert-True ($source -match 'function\s+markdownListContext[\s\S]{0,1400}activeListIndents[\s\S]{0,1400}continuation\[i\]') `
  "ugnježdene liste moraju koristiti linearno stanje umesto backward skeniranja"
Assert-True ($source -match 'extractMarkdownCodeBlocksForRender[\s\S]{0,350}listContext\s*=\s*markdownListContext\(lines\)[\s\S]{0,2800}!listContext\.nested\[i\][\s\S]{0,120}!listContext\.continuation\[i\]') `
  "parser koda mora koristiti unapred izračunati list kontekst u O(1)"
Assert-True ($source -notmatch 'for\s*\([^)]*=\s*index\s*-\s*1[^)]*;[^)]*>=\s*0') `
  "renderer ne sme vraćati skener unazad za svaku list stavku"
Assert-True ($source -match 'html\s*=\s*html\.replace\(/@@CODEI\(\\d\+\)@@/g[\s\S]{0,500}html\s*=\s*html\.replace\(/@@MATH\(\[BI\]\)\(\\d\+\)@@/g') `
  "inline code i matematika moraju se vratiti jednim linearnim prolazom"
Assert-True ($source -notmatch '(?s)(?:inlineCodes|protectedMath\.maths)\.forEach\(.{0,350}?replaceAll') `
  "renderer ne sme skenirati ceo HTML posebno za svaki placeholder"
Assert-True ($source -match 's\s*=\s*s\.replace\(/@@SAFEHTML\(\\d\+\)@@/g[\s\S]{0,500}s\s*=\s*s\.replace\(/@@ESC\(\\d\+\)@@/g') `
  "safe HTML i escaped znakovi moraju se vratiti jednim linearnim prolazom"
Assert-True ($source -notmatch '(?s)(?:safeHtml|escaped)\.forEach\(.{0,350}?replaceAll') `
  "inline renderer ne sme skenirati ceo red posebno za svaki placeholder"
Assert-True ($source -match 'markdownFenceCloses[\s\S]{0,380}match\[2\]\.length\s*>=\s*opening\.length') `
  "duži validni closing fence mora zatvoriti isti tip opener-a"
Assert-True ($source -match 'neutralLanguages\s*=\s*new Set[\s\S]{0,260}"plaintext"[\s\S]{0,260}if\s*\(!neutralLanguages\.has\(language\)\)\s*return false') `
  "eksplicitni programski i nepoznati fence jezici moraju ostati code block"
Assert-True ($source -match 'looksLikeJson\s*\|\|[\s\S]{0,120}looksLikeYaml\s*\|\|[\s\S]{0,120}looksLikeMarkup\s*\|\|[\s\S]{0,120}looksLikeListSource\s*\|\|[\s\S]{0,120}codePatterns\.some') `
  "JSON, YAML, markup, doslovna lista i sadržaj koji liči na program moraju biti zaštićeni od unwrap-a"
Assert-True ($source -match 'if\s*\(final\s*&&\s*accidental\)') `
  "heuristički unwrap sme da se desi samo u završnom prikazu"
Assert-True ($source -match 'extractMarkdownCodeBlocksForRender\(text,\s*codeBlocks,\s*final\)[\s\S]{0,2200}normalizeSchoolMathSource\(text\)[\s\S]{0,500}protectMath\(text\)') `
  "sav pravi kod mora biti zaštićen pre bilo koje TeX normalizacije"
Assert-True ($source -notmatch 'repairAccidentalSchoolCodeBlocks|extractIndentedMarkdownCodeBlocks|closeUnfinishedMarkdownFenceForRender') `
  "stari neusaglašeni fence parseri ne smeju ostati u aplikaciji"
Assert-True ($source -match 'escapeHtml\(item\.lang\)[\s\S]{0,100}escapeHtml\(item\.code\)') `
  "fence jezik i pravi kod moraju ostati HTML-escape-ovani"
Assert-True ($source -match "'ui/safe'") `
  "MathJax mora filtrirati nepoverljive atribute iz model-generisanih formula"
Assert-True ($source -match "URLs:\s*'none'[\s\S]{0,180}classes:\s*'none'[\s\S]{0,180}cssIDs:\s*'none'[\s\S]{0,180}styles:\s*'none'") `
  "formula ne sme praviti linkove, klase, ID-jeve ili stilove"
Assert-True ($source -match 'safeProtocols:[\s\S]{0,260}javascript:\s*false[\s\S]{0,120}data:\s*false') `
  "MathJax mora zabraniti javascript i data protokole"
Assert-True ($source -match 'https://cdn\.jsdelivr\.net/npm/mathjax@4\.1\.3/tex-svg\.js') `
  "MathJax CDN verzija mora biti tačno pinovana"
Assert-True ($source -match 'function\s+trailingUnansweredUserMessage\s*\(') `
  "mora postojati prepoznavanje poslednjeg korisnickog turna bez odgovora"
Assert-True ($source -match 'async\s+function\s+apiImageFromSavedMessage\s*\(') `
  "ponovno slanje slike mora ucitati original iz lokalne baze"
Assert-True ($source -match 'blob\.size\s*>\s*MAX_API_IMAGE_BYTES[\s\S]{0,180}prepareImage\(blob\)') `
  "prevelika istorijska slika mora ponovo proći adaptivnu obradu pre slanja"
Assert-True ($source -match 'if\s*\(busy\s*\|\|\s*sendPreparing\)\s*return') `
  "priprema slanja mora blokirati dupli klik"
Assert-True ($source -match 'history\[history\.length\s*-\s*1\]\s*!==\s*savedUserMessage') `
  "asinhrono ucitavanje mora ponovo proveriti isti sacuvani turn"
Assert-True ($source -match 'source\.slice\(0,\s*-1\)') `
  "tekuci korisnicki turn mora biti izuzet iz lokalnog konteksta"
Assert-True ($source -match 'Sa.uvana slika vi.e nije dostupna') `
  "nedostupna sacuvana slika mora zaustaviti zahtev i traziti novo prilaganje"
Assert-True ($source -notmatch 'window\.fetch\s*=|AbortSignal\.timeout') `
  "globalni fetch/timer monkeypatch ne sme postojati u aplikaciji"
Assert-True ($source -notmatch 'google_search|googleSearch|google_search_retrieval') `
  "Google Search grounding ne sme postojati u izvoru"
Assert-True ($manifest -notmatch '(?i)gemini') `
  "PWA manifest ne sme prikazivati naziv provajdera/modela"

$publicArtifacts = $source + $loader + $serviceWorker + $manifest
Assert-True ($publicArtifacts -notmatch 'AIza[A-Za-z0-9_-]{30,}|AQ\.[A-Za-z0-9._-]{30,}') `
  "produkcijski frontend ne sme sadržati literal koji liči na stvarni API ključ"

$localSecretFile = Join-Path $repoRoot "api_keys.txt"
if (Test-Path -LiteralPath $localSecretFile) {
  $knownSecrets = [IO.File]::ReadAllLines(
    $localSecretFile,
    [Text.Encoding]::UTF8
  ) | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -ge 8 }

  foreach ($knownSecret in $knownSecrets) {
    Assert-True (-not $publicArtifacts.Contains($knownSecret)) `
      "stvarni lokalni API ključ ne sme biti ugrađen u produkcijski frontend"
  }
}

Assert-True ($loader -notmatch 'window\.fetch\s*=|AbortSignal\.timeout|realSetTimeout') `
  "loader više ne sme sadržati Stop monkeypatch"
Assert-True ((Count-Matches $loader 'app-v5/part-[^''"]+\.txt\?v=20') -eq 9) `
  "loader mora koristiti svih 9 chunk URL-ova sa v=20"
Assert-True ($serviceWorker -match 'CACHE_NAME\s*=\s*"matematika-pwa-v26"') `
  "service worker cache mora biti v26"
Assert-True ((Count-Matches $serviceWorker 'app-v5/part-[^''"]+\.txt\?v=20') -eq 9) `
  "service worker mora keširati svih 9 chunk URL-ova sa v=20"

& (Join-Path $PSScriptRoot "build-math-app.ps1") -CheckOnly | Out-Null
Write-Output "Sve statičke provere matematičke aplikacije su prošle."
