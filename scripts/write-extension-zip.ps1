param(
    [Parameter(Mandatory = $true)][string]$ExtensionRoot,
    [Parameter(Mandatory = $true)][string]$ArchivePath
)

$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath $ExtensionRoot).Path.TrimEnd([char]92, [char]47)
if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'manifest.json') -PathType Leaf)) {
    throw 'Extension root must contain manifest.json.'
}
if (Test-Path -LiteralPath $ArchivePath) {
    throw 'Archive destination already exists; choose a fresh filename.'
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($ArchivePath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -File -Recurse | Sort-Object FullName) {
        if ($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw 'Extension archives require regular source files.'
        }
        $relative = $file.FullName.Substring($sourceRoot.Length + 1).Replace([char]92, [char]47)
        if ($relative.StartsWith('/') -or $relative.Split('/').Contains('..')) {
            throw "Invalid extension entry: $relative"
        }
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive,
            $file.FullName,
            $relative,
            [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
} finally {
    $archive.Dispose()
}
