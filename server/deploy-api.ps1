param([string]$SshTarget = 'root@175.178.13.169')

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sshOptions = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes')
if ($SshTarget -notmatch '^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+$') { throw 'Invalid SSH target.' }
Push-Location $projectRoot
try {
    npm.cmd run verify
    if ($LASTEXITCODE -ne 0) { throw 'Verification failed.' }
    $previous = (ssh @sshOptions $SshTarget 'readlink -f /srv/biliskipad/current').Trim()
    if ($LASTEXITCODE -ne 0 -or $previous -notmatch '^/srv/biliskipad/releases/[0-9]{8}-[0-9]{6}-[a-f0-9]{12}$') { throw 'Unexpected current release.' }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $archive = Join-Path $projectRoot ".tmp/biliskipad-api-$stamp.tar.gz"
    $files = @('server/app.js', 'server/badges.js', 'server/config.js', 'server/healthcheck.js', 'server/index.js', 'server/store.js', 'server/validation.js', 'server/deploy/nginx.conf', 'server/site/privacy.html')
    tar.exe -czf $archive @files
    if ($LASTEXITCODE -ne 0) { throw 'Archive creation failed.' }
    $digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    $release = "$stamp-$($digest.Substring(0, 12))"
    $remoteArchive = "/tmp/biliskipad-api-$release.tar.gz"
    $remoteScript = "/tmp/biliskipad-api-$release.sh"
    scp @sshOptions $archive "${SshTarget}:$remoteArchive"
    if ($LASTEXITCODE -ne 0) { throw 'Archive upload failed.' }
    scp @sshOptions (Join-Path $PSScriptRoot 'deploy/api.sh') "${SshTarget}:$remoteScript"
    if ($LASTEXITCODE -ne 0) { throw 'Script upload failed.' }
    ssh @sshOptions $SshTarget "bash '$remoteScript' '$remoteArchive' '$digest' '$release' '$previous'"
    if ($LASTEXITCODE -ne 0) { throw 'API deployment failed; inspect rollback output.' }
    Write-Output "API release: $release"
} finally { Pop-Location }
