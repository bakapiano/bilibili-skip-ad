param(
    [Parameter(Mandatory = $true)][string]$ModelFile,
    [string]$SshTarget = 'root@175.178.13.169'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sshOptions = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes')
if ($SshTarget -notmatch '^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+$') { throw 'Invalid SSH target.' }
$source = Get-Item -LiteralPath $ModelFile
if ($source.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Model must be a regular file.' }
$hash = (Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' -or $source.Length -ne 239233841) {
    throw 'Model bytes must match the pinned SenseVoice INT8 snapshot.'
}
Push-Location $projectRoot
try {
    npm.cmd run verify
    if ($LASTEXITCODE -ne 0) { throw 'Verification failed.' }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $remote = "/tmp/biliskip-model-$stamp"
    foreach ($entry in @(
        @($source.FullName, "$remote.onnx"),
        @((Join-Path $PSScriptRoot 'deploy/nginx.conf'), "$remote.nginx"),
        @((Join-Path $projectRoot 'extension/asr/vendor/FUNASR-MODEL-LICENSE'), "$remote.license"),
        @((Join-Path $PSScriptRoot 'MODEL-NOTICE.md'), "$remote.notice"),
        @((Join-Path $PSScriptRoot 'deploy/model.sh'), "$remote.sh")
    )) {
        scp @sshOptions $entry[0] "${SshTarget}:$($entry[1])"
        if ($LASTEXITCODE -ne 0) { throw 'Model deployment upload failed.' }
    }
    ssh @sshOptions $SshTarget "bash '$remote.sh' '$stamp'"
    if ($LASTEXITCODE -ne 0) { throw 'Model deployment failed; inspect rollback output.' }
} finally {
    Pop-Location
}
