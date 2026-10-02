param([string]$SshTarget = 'root@175.178.13.169')

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$vendorRoot = Join-Path $projectRoot 'extension/asr/vendor'
$sshOptions = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes')
if ($SshTarget -notmatch '^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+$') { throw 'Invalid SSH target.' }
$payload = @('runtime.wasm', 'support.bin', 'NOTICE.md', 'LICENSE', 'ONNXRUNTIME-LICENSE', 'ONNXRUNTIME-NOTICES', 'SILERO-LICENSE', 'FUNASR-MODEL-LICENSE', 'provenance.json')
foreach ($file in $payload) {
    $item = Get-Item -LiteralPath (Join-Path $vendorRoot $file)
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'ASR resources must be regular files.' }
}
Push-Location $projectRoot
try {
    npm.cmd run verify
    if ($LASTEXITCODE -ne 0) { throw 'Verification failed.' }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bundle = Join-Path $projectRoot ".tmp/asr-resources-$stamp.tar.gz"
    tar.exe -czf $bundle -C $vendorRoot @payload
    if ($LASTEXITCODE -ne 0) { throw 'ASR resources archive failed.' }
    $hash = (Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant()
    $remote = "/tmp/biliskip-asr-resources-$stamp"
    foreach ($entry in @(
        @($bundle, "$remote.tar.gz"),
        @((Join-Path $PSScriptRoot 'deploy/nginx.conf'), "$remote.nginx"),
        @((Join-Path $PSScriptRoot 'deploy/asr-resources.sh'), "$remote.sh")
    )) {
        scp @sshOptions $entry[0] "${SshTarget}:$($entry[1])"
        if ($LASTEXITCODE -ne 0) { throw 'ASR resource upload failed.' }
    }
    ssh @sshOptions $SshTarget "bash '$remote.sh' '$stamp' '$hash'"
    if ($LASTEXITCODE -ne 0) { throw 'ASR resource deployment failed; inspect rollback output.' }
} finally {
    Pop-Location
}
