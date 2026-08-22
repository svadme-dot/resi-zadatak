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

Assert-True ($source -match '<div class="mobileNavModel">Re.avanje zadataka</div>') `
  "bocni meni mora prikazivati trazeni podnaslov"

Assert-True ($request -match 'model:\s*DEFAULT_MODEL') `
  "glavni zahtev mora koristiti fiksni DEFAULT_MODEL"
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
Assert-True ($source -match 'model:\s*DEFAULT_MODEL') `
  "profili moraju biti normalizovani na DEFAULT_MODEL"
Assert-True ($source -notmatch 'requestGeneratedChatTitle') `
  "skriveni Gemini zahtev za naslov mora biti uklonjen"
Assert-True ($source -match 'activeSolveController\s*=\s*new AbortController') `
  "Stop mora koristiti eksplicitni solve AbortController"
Assert-True ($source -match 'isUserStopError\(err, solveSignal\)') `
  "send mora posebno obraditi korisnički Stop"
Assert-True ($source -match '!hasPartial\s*&&\s*isEligibleProfileFallbackError') `
  "fallback mora zahtevati da nema parcijalnog sadržaja"
Assert-True ($source -match 'completionState:\s*"stopped"') `
  "zaustavljeni parcijalni odgovor mora biti sačuvan"
Assert-True ($source -match 'saveCurrentInteractionId\("",\s*""\)') `
  "prekinuti turn mora očistiti stari server-side interaction ID"
Assert-True ($source -notmatch 'window\.fetch\s*=|AbortSignal\.timeout') `
  "globalni fetch/timer monkeypatch ne sme postojati u aplikaciji"
Assert-True ($source -notmatch 'google_search|googleSearch|google_search_retrieval') `
  "Google Search grounding ne sme postojati u izvoru"

Assert-True ($loader -notmatch 'window\.fetch\s*=|AbortSignal\.timeout|realSetTimeout') `
  "loader više ne sme sadržati Stop monkeypatch"
Assert-True ((Count-Matches $loader 'app-v5/part-[^''"]+\.txt\?v=11') -eq 9) `
  "loader mora koristiti svih 9 chunk URL-ova sa v=11"
Assert-True ($serviceWorker -match 'CACHE_NAME\s*=\s*"matematika-pwa-v17"') `
  "service worker cache mora biti v17"
Assert-True ((Count-Matches $serviceWorker 'app-v5/part-[^''"]+\.txt\?v=11') -eq 9) `
  "service worker mora keširati svih 9 chunk URL-ova sa v=11"

& (Join-Path $PSScriptRoot "build-math-app.ps1") -CheckOnly | Out-Null
Write-Output "Sve statičke provere matematičke aplikacije su prošle."
