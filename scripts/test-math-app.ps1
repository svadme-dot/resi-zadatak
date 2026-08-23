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
$requestEnd = $source.IndexOf("  function extractContentText", $requestStart)
Assert-True ($requestStart -ge 0 -and $requestEnd -gt $requestStart) `
  "buildInteractionRequest nije pronađen"
$request = $source.Substring($requestStart, $requestEnd - $requestStart)

$inputStart = $source.IndexOf("  function buildInteractionInput")
$inputEnd = $source.IndexOf("  function buildInteractionRequest", $inputStart)
Assert-True ($inputStart -ge 0 -and $inputEnd -gt $inputStart) `
  "buildInteractionInput nije pronadjen"
$interactionInput = $source.Substring($inputStart, $inputEnd - $inputStart)

Assert-True ($source -match '<div class="mobileNavModel">Re.avanje zadataka</div>') `
  "bocni meni mora prikazivati trazeni podnaslov"

Assert-True ($source -notmatch '(?i)gemini') `
  "frontend izvor ne sme sadržati korisniku vidljiv naziv provajdera/modela"
Assert-True ($source -match 'const\s+API_GATEWAY_URL\s*=') `
  "frontend mora koristiti server-side API gateway"
Assert-True ($source -match 'const\s+API_SLOT_ORDER\s*=\s*Object\.freeze\(\[1,\s*2,\s*3,\s*4\]\)') `
  "redosled API slotova mora ostati 1, 2, 3, 4"
Assert-True ($source -match '"X-Math-Api-Slot":\s*String\(slot\)') `
  "gateway zahtev mora slati samo neutralni broj API slota"
Assert-True ($source -notmatch 'x-goog-api-key|generativelanguage\.googleapis\.com') `
  "frontend ne sme direktno slati ključ niti pozivati upstream servis"
Assert-True ($request -notmatch '\bmodel\s*:|system_instruction\s*:|generation_config\s*:|tools\s*:') `
  "model, prompt, alati i thinking konfiguracija moraju biti fiksirani server-side"
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

Assert-True ($source -notmatch 'type="password"|id="keyOverlay"|id="googleKey[1-4]"') `
  "browser više ne sme nuditi niti čuvati API ključeve"
Assert-True ($source -match 'function\s+removeLegacyBrowserSecrets\s*\(') `
  "prethodno lokalno sačuvani API ključevi moraju se obrisati pri nadogradnji"
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
Assert-True ($source -match 'const\s+canUseNextProfile\s*=\s*\r?\n\s*canUseNextApiProfile\(err\)') `
  "send mora koristiti thinking-aware profil fallback odluku"
Assert-True ($source -match 'slot_rate_limited",\s*"slot_unavailable"') `
  "lokalno popunjen ili nekonfigurisan slot mora odmah preći na sledeći bez istog-slot retry-ja"
Assert-True ($source -match 'rate_control_unavailable[\s\S]{0,80}return false') `
  "globalna greška rate koordinatora ne sme fan-outovati isti zahtev kroz sva četiri slota"
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
Assert-True ($source -match 'markdownToHtml\(sanitizeServiceMessage\(text\)\)') `
  "svaki prikaz serverskog odgovora mora neutralisati naziv provajdera/modela"
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

Assert-True ($loader -notmatch 'window\.fetch\s*=|AbortSignal\.timeout|realSetTimeout') `
  "loader više ne sme sadržati Stop monkeypatch"
Assert-True ((Count-Matches $loader 'app-v5/part-[^''"]+\.txt\?v=17') -eq 9) `
  "loader mora koristiti svih 9 chunk URL-ova sa v=17"
Assert-True ($serviceWorker -match 'CACHE_NAME\s*=\s*"matematika-pwa-v23"') `
  "service worker cache mora biti v23"
Assert-True ((Count-Matches $serviceWorker 'app-v5/part-[^''"]+\.txt\?v=17') -eq 9) `
  "service worker mora keširati svih 9 chunk URL-ova sa v=17"

& (Join-Path $PSScriptRoot "build-math-app.ps1") -CheckOnly | Out-Null
Write-Output "Sve statičke provere matematičke aplikacije su prošle."
