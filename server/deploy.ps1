param(
    [string]$SshTarget = 'root@175.178.13.169',
    [string]$ExtensionArchive = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$tempRoot = Join-Path $projectRoot '.tmp'
$sshOptions = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes')
if ($SshTarget -notmatch '^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+$') { throw 'Invalid SSH target.' }

Push-Location $projectRoot
try {
    if (-not $ExtensionArchive) {
        $packOutput = & (Join-Path $projectRoot 'scripts\package-extension.ps1') -Store
        $packOutput | Write-Output
        $archiveLine = @($packOutput | Where-Object { $_ -is [string] -and $_.StartsWith('Archive: ') })
        if ($archiveLine.Count -ne 1) { throw 'Could not resolve the generated extension archive.' }
        $ExtensionArchive = $archiveLine[0].Substring(9)
    } else {
        npm.cmd run verify
        if ($LASTEXITCODE -ne 0) { throw 'Project verification failed.' }
    }
    $archivePath = (Resolve-Path -LiteralPath $ExtensionArchive).Path
    $extensionRoot = Join-Path $projectRoot 'extension'
    $sourceFiles = @(Get-ChildItem -LiteralPath $extensionRoot -File -Recurse | ForEach-Object { $_.FullName.Substring($extensionRoot.Length + 1).Replace('\', '/') })
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $extensionZip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    $contentHasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $entries = @($extensionZip.Entries | Where-Object { $_.Name -ne '' })
        if ($entries.Count -ne $sourceFiles.Count) { throw 'Extension archive file count differs from current sources.' }
        foreach ($entry in $entries) {
            if (-not $sourceFiles.Contains($entry.FullName)) { throw "Unexpected extension archive entry: $($entry.FullName)" }
            $packedStream = $entry.Open()
            $sourceStream = [System.IO.File]::OpenRead((Join-Path $extensionRoot $entry.FullName))
            try {
                $packedHash = [System.BitConverter]::ToString($contentHasher.ComputeHash($packedStream))
                $sourceHash = [System.BitConverter]::ToString($contentHasher.ComputeHash($sourceStream))
                if ($packedHash -ne $sourceHash) { throw "Extension archive differs from current source: $($entry.FullName)" }
            } finally { $packedStream.Dispose(); $sourceStream.Dispose() }
        }
    } finally { $contentHasher.Dispose(); $extensionZip.Dispose() }
    $siteOutput = node (Join-Path $projectRoot 'scripts\build-site.js') $archivePath
    if ($LASTEXITCODE -ne 0) { throw 'Site build failed.' }
    $siteBuild = $siteOutput | ConvertFrom-Json
    $siteRoot = Join-Path $tempRoot 'site-build'
    $siteFiles = @($siteBuild.files)
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bundlePath = Join-Path $tempRoot "biliskipad-$stamp.tar.gz"
    $payloadFiles = @(
        'LICENSE',
        'package.json',
        'server/app.js', 'server/badges.js', 'server/config.js', 'server/healthcheck.js',
        'server/index.js', 'server/store.js', 'server/validation.js',
        'server/deploy/compose.yaml', 'server/deploy/nginx.conf',
        'server/deploy/nginx-http.conf'
    )
    foreach ($file in $payloadFiles) {
        $entry = Get-Item -LiteralPath (Join-Path $projectRoot $file)
        if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "Payload should be a regular file: $file" }
    }
    foreach ($file in $siteFiles) {
        $entry = Get-Item -LiteralPath (Join-Path $siteRoot $file)
        if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "Site payload should be a regular file: $file" }
    }
    tar.exe -czf $bundlePath -C $projectRoot @payloadFiles -C $siteRoot @siteFiles
    if ($LASTEXITCODE -ne 0) { throw 'Deployment archive creation failed.' }
    $stream = [System.IO.File]::OpenRead($bundlePath)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = [System.BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose(); $stream.Dispose() }
    $release = "$stamp-$($hash.Substring(0, 12))"
    $remoteBundle = "/tmp/biliskipad-$release.tar.gz"
    $remoteScript = "/tmp/biliskipad-install-$release.sh"
    scp @sshOptions $bundlePath "${SshTarget}:$remoteBundle"
    if ($LASTEXITCODE -ne 0) { throw 'Archive upload failed.' }
    scp @sshOptions (Join-Path $PSScriptRoot 'deploy\install.sh') "${SshTarget}:$remoteScript"
    if ($LASTEXITCODE -ne 0) { throw 'Deployment script upload failed.' }
    ssh @sshOptions $SshTarget "bash '$remoteScript' '$remoteBundle' '$hash' '$release'"
    if ($LASTEXITCODE -ne 0) { throw 'Remote deployment failed; review the rollback output.' }
    Write-Output "Deployed release: $release"
} finally {
    Pop-Location
}
