$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$extensionRoot = Join-Path $projectRoot 'extension'
$outputRoot = Join-Path $projectRoot 'dist'
Push-Location $projectRoot
try {
    node scripts/check-extension.js
    if ($LASTEXITCODE -ne 0) { throw 'Extension validation failed.' }
    node --test --test-reporter=dot tests/*.test.cjs tests/extension/*.test.js
    if ($LASTEXITCODE -ne 0) { throw 'Extension tests failed.' }
    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
    $version = (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $extensionRoot 'manifest.json') | ConvertFrom-Json).version
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $archive = Join-Path $outputRoot "biliskip-$version-$stamp.zip"
    Compress-Archive -Path (Join-Path $extensionRoot '*') -DestinationPath $archive
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
    try {
        if ($null -eq $zip.GetEntry('manifest.json')) { throw 'Archive must contain manifest.json at its root.' }
        $fileCount = @($zip.Entries | Where-Object { $_.Name -ne '' }).Count
        $sourceCount = @(Get-ChildItem -LiteralPath $extensionRoot -File -Recurse).Count
        if ($fileCount -ne $sourceCount) { throw 'Archive file count does not match extension sources.' }
    } finally { $zip.Dispose() }
    $stream = [System.IO.File]::OpenRead($archive)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { $digest = [System.BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose(); $stream.Dispose() }
    Write-Output "Archive: $archive"
    Write-Output "Files: $fileCount"
    Write-Output "SHA256: $digest"
} finally { Pop-Location }
