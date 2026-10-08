$ErrorActionPreference = 'Stop'
node (Join-Path $PSScriptRoot 'generate-icons.js')
if ($LASTEXITCODE -ne 0) { throw 'Icon generation failed.' }
