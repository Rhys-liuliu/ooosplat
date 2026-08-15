$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $workspace 'engines\manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Missing engine manifest: $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach ($item in $manifest.requiredFiles) {
  $path = Join-Path $workspace $item.path
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing engine file: $($item.path). Run 'npm run setup:engines' first." }
  $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
  if ($actual -ne $item.sha256) { throw "Hash mismatch for $($item.path): $actual" }
}
$cudaFiles = Get-ChildItem -LiteralPath (Join-Path $workspace 'engines\colmap') -Recurse -File | Where-Object { $_.Name -match '(?i)cudart|cublas|cudnn|cuda\.dll' }
if ($cudaFiles) { throw "CUDA runtime found in CPU COLMAP package: $($cudaFiles.FullName -join ', ')" }
$colmap = Join-Path $workspace 'engines\colmap\bin\colmap.exe'
$savedPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$help = & $colmap feature_extractor -h 2>&1 | Out-String
$colmapExit = $LASTEXITCODE
if ($colmapExit -ne 0 -or $help -notmatch '(?i)without CUDA') { throw 'Bundled COLMAP did not explicitly report without CUDA.' }
$brush = Join-Path $workspace 'engines\brush\brush_app.exe'
$brushHelp = & $brush --help 2>&1 | Out-String
$brushExit = $LASTEXITCODE
$ErrorActionPreference = $savedPreference
if ($brushExit -ne 0) { throw "Bundled Brush help failed with exit code $brushExit" }
foreach ($flag in '--total-steps','--max-resolution','--export-path','--export-name') {
  if ($brushHelp -notmatch [regex]::Escape($flag)) { throw "Bundled Brush is missing $flag" }
}
Write-Host "Verified $($manifest.requiredFiles.Count) locked engine files; COLMAP CPU/no-CUDA and Brush CLI are valid."
