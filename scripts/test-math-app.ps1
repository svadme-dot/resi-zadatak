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

$inputStart = $source.IndexOf("  function buildInteractionInput")
$inputEnd = $source.IndexOf("  function buildInteractionRequest", $inputStart)
Assert-True ($inputStart -ge 0 -and $inputEnd -gt $inputStart) `
  "buildInteractionInput nije pronadjen"
$interactionInput = $source.Substring($inputStart, $inputEnd - $inputStart)

Assert-True ($source -match '<div class="mobileNavModel">Re.avanje zadataka</div>') `
  "bocni meni mora prikazivati trazeni podnaslov"

Assert-True ($source -match 'const\s+PRIMARY_MODEL\s*=\s*"gemini-3\.6-flash"') `
  "jedini model mora biti Gemini 3.6 Flash"
Assert-True ($source -notmatch 'gemini-3\.7-flash|FALLBACK_MODEL') `
  "Gemini 3.7 i drugi model ne smeju ostati u aplikaciji"
Assert-True ($request -match 'model:\s*requireAttemptModel\(model\)') `
  "glavni zahtev mora koristiti validirani model tekuceg pokusaja"
Assert-True ($request -notmatch 'model:\s*PRIMARY_MODEL') `
  "glavni zahtev mora koristiti model aktivnog API pokusaja"
Assert-True ($interactionInput -match 'resolution:\s*IMAGE_MEDIA_RESOLUTION') `
  "svaka slika mora traziti high media resolution"
Assert-True ($source -match 'const\s+IMAGE_MEDIA_RESOLUTION\s*=\s*"high"') `
  "Interactions media resolution mora biti high"
Assert-True ((Count-Matches $request 'type:\s*"code_execution"') -eq 1) `
  "glavni zahtev mora imati tačno jedan code_execution alat"
Assert-True ((Count-Matches $request 'thinking_level:\s*"high"') -eq 1) `
  "glavni zahtev mora imati high thinking"
Assert-True ((Count-Matches $request 'thinking_summaries:\s*"auto"') -eq 1) `
  "glavni zahtev mora imati thinking summaries auto tačno jednom"
Assert-True ($request -notmatch 'google_search|googleSearch|google_search_retrieval') `
  "Google Search grounding ne sme biti u glavnom zahtevu"
Assert-True ($request -notmatch 'background\s*:\s*true') `
  "background režim još ne sme biti uključen"

Assert-True ((Count-Matches $source 'id="googleModel[1-4]"[^>]*readonly') -eq 4) `
  "sva četiri polja modela moraju biti fiksna/readonly"
Assert-True ((Count-Matches $source 'value="gemini-3\.6-flash"') -eq 4) `
  "sva cetiri polja moraju prikazati samo Gemini 3.6 Flash"
Assert-True ($source -match 'MODEL_ATTEMPT_ORDER\s*=\s*Object\.freeze\(\[\s*PRIMARY_MODEL\s*\]\)') `
  "redosled modela mora sadrzati samo Gemini 3.6 Flash"
Assert-True ($source -match 'MODEL_ATTEMPT_ORDER\.flatMap\(model\s*=>\s*\r?\n\s*configuredSlots\.map') `
  "redosled mora biti API slotovi 1 do 4 samo na Gemini 3.6 Flash"
Assert-True ($source -notmatch 'DEFAULT_MODEL') `
  "stari single-model DEFAULT_MODEL ne sme ostati u izvoru"
Assert-True ($source -notmatch 'requestGeneratedChatTitle') `
  "skriveni Gemini zahtev za naslov mora biti uklonjen"
Assert-True ($source -match 'activeSolveController\s*=\s*new AbortController') `
  "Stop mora koristiti eksplicitni solve AbortController"
Assert-True ($source -match 'isUserStopError\(err, solveSignal\)') `
  "send mora posebno obraditi korisnički Stop"
Assert-True ($source -match 'function\s+hasVisibleLiveAnswer\s*\(') `
  "fallback mora razlikovati thinking od stvarno zapocetog odgovora"
Assert-True ($source -match 'function\s+canUseNextGoogleProfile\s*\(err\)[\s\S]{0,420}isRetriableDemandError\(err\)\s*&&\s*\r?\n\s*!hasVisibleLiveAnswer\(\)') `
  "high-demand sme da odbaci samo thinking bez finalnog odgovora"
Assert-True ($source -match 'const\s+canUseNextProfile\s*=\s*\r?\n\s*canUseNextGoogleProfile\(err\)') `
  "send mora koristiti thinking-aware profil fallback odluku"
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
Assert-True ($source -match 'el\("saveKey"\)\.addEventListener\("click",\s*\(\)\s*=>\s*\{\s*if\s*\(busy\s*\|\|\s*sendPreparing\)') `
  "API kljucevi ne smeju da se promene tokom aktivnog slanja"
Assert-True ($source -match 'function\s+trailingUnansweredUserMessage\s*\(') `
  "mora postojati prepoznavanje poslednjeg korisnickog turna bez odgovora"
Assert-True ($source -match 'async\s+function\s+apiImageFromSavedMessage\s*\(') `
  "ponovno slanje slike mora ucitati original iz lokalne baze"
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

Assert-True ($loader -notmatch 'window\.fetch\s*=|AbortSignal\.timeout|realSetTimeout') `
  "loader više ne sme sadržati Stop monkeypatch"
Assert-True ((Count-Matches $loader 'app-v5/part-[^''"]+\.txt\?v=15') -eq 9) `
  "loader mora koristiti svih 9 chunk URL-ova sa v=15"
Assert-True ($serviceWorker -match 'CACHE_NAME\s*=\s*"matematika-pwa-v21"') `
  "service worker cache mora biti v21"
Assert-True ((Count-Matches $serviceWorker 'app-v5/part-[^''"]+\.txt\?v=15') -eq 9) `
  "service worker mora keširati svih 9 chunk URL-ova sa v=15"

& (Join-Path $PSScriptRoot "build-math-app.ps1") -CheckOnly | Out-Null
Write-Output "Sve statičke provere matematičke aplikacije su prošle."
