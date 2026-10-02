param([switch]$Store)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$extensionRoot = Join-Path $projectRoot 'extension'
$outputRoot = Join-Path $projectRoot 'dist'
Push-Location $projectRoot
try {
    npm.cmd run verify
    if ($LASTEXITCODE -ne 0) { throw 'Project verification failed.' }
    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
    $version = (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $extensionRoot 'manifest.json') | ConvertFrom-Json).version
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $purpose = if ($Store) { '-chrome-web-store' } else { '' }
    $archive = Join-Path $outputRoot "biliskip-$version$purpose-$stamp.zip"
    & (Join-Path $PSScriptRoot 'write-extension-zip.ps1') -ExtensionRoot $extensionRoot -ArchivePath $archive
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
    try {
        if ($null -eq $zip.GetEntry('manifest.json')) { throw 'Archive must contain manifest.json at its root.' }
        $fileCount = @($zip.Entries | Where-Object { $_.Name -ne '' }).Count
        $sourceCount = @(Get-ChildItem -LiteralPath $extensionRoot -File -Recurse).Count
        if ($fileCount -ne $sourceCount) { throw 'Archive file count does not match extension sources.' }
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName.Contains('\') -or $entry.FullName.StartsWith('/') -or $entry.FullName.Split('/').Contains('..')) {
                throw "Unsafe archive path: $($entry.FullName)"
            }
            $legalNotices = @('LICENSE', 'ONNXRUNTIME-LICENSE', 'ONNXRUNTIME-NOTICES', 'SILERO-LICENSE', 'FUNASR-MODEL-LICENSE')
            if ($entry.Name -ne '' -and $entry.Name -notin $legalNotices -and $entry.FullName -notmatch '\.(js|html|css|json|png|wasm|bin|md|txt)$') {
                throw "Unexpected archive file: $($entry.FullName)"
            }
        }
    } finally { $zip.Dispose() }
    $stream = [System.IO.File]::OpenRead($archive)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { $digest = [System.BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose(); $stream.Dispose() }
    [System.IO.File]::WriteAllText("$archive.sha256", "$digest  $([System.IO.Path]::GetFileName($archive))`n", [System.Text.UTF8Encoding]::new($false))
    Write-Output "Archive: $archive"
    Write-Output "Files: $fileCount"
    Write-Output "SHA256: $digest"
} finally { Pop-Location }
