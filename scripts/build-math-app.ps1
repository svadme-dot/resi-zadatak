param(
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $repoRoot "src\math-app.html"
$outputDir = Join-Path $repoRoot "docs\app-v5"

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "Nedostaje izvor matematičke aplikacije: $sourcePath"
}

$utf8NoBom = [Text.UTF8Encoding]::new($false)
$sourceText = [IO.File]::ReadAllText($sourcePath, [Text.Encoding]::UTF8)
$sourceBytes = $utf8NoBom.GetBytes($sourceText)

$compressedStream = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GzipStream]::new(
  $compressedStream,
  [IO.Compression.CompressionLevel]::Optimal,
  $true
)
$gzip.Write($sourceBytes, 0, $sourceBytes.Length)
$gzip.Dispose()
$base64 = [Convert]::ToBase64String($compressedStream.ToArray())
$compressedStream.Dispose()

$logicalPartCount = 8
$logicalPartLength = [Math]::Ceiling($base64.Length / $logicalPartCount)
$parts = [ordered]@{}

for ($index = 0; $index -lt $logicalPartCount; $index++) {
  $start = $index * $logicalPartLength
  if ($start -ge $base64.Length) {
    $chunk = ""
  } else {
    $length = [Math]::Min($logicalPartLength, $base64.Length - $start)
    $chunk = $base64.Substring($start, $length)
  }

  if ($index -eq 5) {
    $firstLength = [Math]::Floor($chunk.Length / 2)
    $parts["part-5a.txt"] = $chunk.Substring(0, $firstLength)
    $parts["part-5b.txt"] = $chunk.Substring($firstLength)
  } else {
    $parts["part-$index.txt"] = $chunk
  }
}

$orderedNames = @(
  "part-0.txt", "part-1.txt", "part-2.txt", "part-3.txt",
  "part-4.txt", "part-5a.txt", "part-5b.txt", "part-6.txt",
  "part-7.txt"
)

if (-not $CheckOnly) {
  New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
  foreach ($entry in $parts.GetEnumerator()) {
    $path = Join-Path $outputDir $entry.Key
    [IO.File]::WriteAllText($path, [string]$entry.Value, [Text.Encoding]::ASCII)
  }
}

$roundTripBase64 = ($orderedNames | ForEach-Object {
  [IO.File]::ReadAllText((Join-Path $outputDir $_), [Text.Encoding]::ASCII)
}) -join ""

$roundTripBytes = [Convert]::FromBase64String($roundTripBase64)
$inputStream = [IO.MemoryStream]::new($roundTripBytes)
$gunzip = [IO.Compression.GzipStream]::new(
  $inputStream,
  [IO.Compression.CompressionMode]::Decompress
)
$reader = [IO.StreamReader]::new($gunzip, [Text.Encoding]::UTF8)
$roundTripText = $reader.ReadToEnd()
$reader.Dispose()
$gunzip.Dispose()
$inputStream.Dispose()

if ($roundTripText -cne $sourceText) {
  throw "Provera pakovanja nije uspela: raspakovani sadržaj se razlikuje od izvora."
}

$mode = if ($CheckOnly) { "proveren" } else { "napravljen" }
Write-Output "Matematički payload je ${mode}: $($sourceBytes.Length) B izvora, $($base64.Length) base64 znakova."
