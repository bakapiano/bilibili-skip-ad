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
    if ($LASTEXITCODE -ne 0 -or $previous -notmatch '^/srv/biliskipad/releases/[0-9]{8}-[0-9]{6}-[a-f0-9]{12}$') { throw 'Invalid current release.' }
    $published = ssh @sshOptions $SshTarget 'cat /srv/biliskipad/current/package.json'
    if ($LASTEXITCODE -ne 0) { throw 'Published package metadata unavailable.' }
    $version = ($published | ConvertFrom-Json).version
    if ($version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') { throw 'Invalid published version.' }
    $siteOutput = node scripts/build-site.js --site-only $version
    if ($LASTEXITCODE -ne 0) { throw 'Site build failed.' }
    $site = $siteOutput | ConvertFrom-Json
    $files = @('server/app.js', 'server/store.js', 'server/validation.js', 'server/deploy/nginx.conf')
    $siteRoot = Join-Path $projectRoot '.tmp/site-build'
    foreach ($file in $files) {
        if ((Get-Item -LiteralPath (Join-Path $projectRoot $file)).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Deployment files must be regular files.' }
    }
    foreach ($file in $site.files) {
        if ((Get-Item -LiteralPath (Join-Path $siteRoot $file)).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Site files must be regular files.' }
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bundle = Join-Path $projectRoot ".tmp/site-update-$stamp.tar.gz"
    tar.exe -czf $bundle -C $projectRoot @files -C $siteRoot @($site.files)
    if ($LASTEXITCODE -ne 0) { throw 'Site archive failed.' }
    $hash = (Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant()
    $release = "$stamp-$($hash.Substring(0, 12))"
    $prefix = "/tmp/biliskip-site-$release"
    scp @sshOptions $bundle "${SshTarget}:$prefix.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw 'Site archive upload failed.' }
    scp @sshOptions (Join-Path $PSScriptRoot 'deploy/site.sh') "${SshTarget}:$prefix.sh"
    if ($LASTEXITCODE -ne 0) { throw 'Installer upload failed.' }
    ssh @sshOptions $SshTarget "bash '$prefix.sh' '$release' '$hash' '$previous'"
    if ($LASTEXITCODE -ne 0) { throw 'Site deployment failed; inspect rollback output.' }
    Write-Output "Deployed site/API: $release; preserved ZIP version: $version"
} finally {
    Pop-Location
}
