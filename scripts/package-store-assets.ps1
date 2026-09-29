param([Parameter(Mandatory = $true)][string]$ExtensionArchive)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.IO.Compression.FileSystem

$projectRoot = Split-Path -Parent $PSScriptRoot
$extensionRoot = Join-Path $projectRoot 'extension'
$storeRoot = Join-Path $projectRoot 'store'
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $extensionRoot 'manifest.json') | ConvertFrom-Json
$version = $manifest.version
$assetRoot = Join-Path $projectRoot "dist\chrome-web-store-assets-$version"
$imageRoot = Join-Path $assetRoot 'images'
$documentRoot = Join-Path $assetRoot 'documents'
$programRoot = Join-Path $assetRoot 'extension'
$copy = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $storeRoot 'visual-copy.json') | ConvertFrom-Json
$inputArchive = (Resolve-Path -LiteralPath $ExtensionArchive).Path

# The two screenshots are captured from the real browser into this artifact directory.
$screenshotNames = @('01-ad-markers-1280x800.png', '02-auto-skip-1280x800.png')
foreach ($name in $screenshotNames) {
    if (-not (Test-Path -LiteralPath (Join-Path $assetRoot "screenshots\$name") -PathType Leaf)) {
        throw "Capture the real browser screenshot first: $name"
    }
}
$archive = [System.IO.Compression.ZipFile]::OpenRead($inputArchive)
try {
    $entry = $archive.GetEntry('manifest.json')
    if ($null -eq $entry) { throw 'Extension ZIP must have a root manifest.' }
    $reader = [System.IO.StreamReader]::new($entry.Open())
    try { $packagedManifest = $reader.ReadToEnd() | ConvertFrom-Json }
    finally { $reader.Dispose() }
    if ($packagedManifest.version -ne $version) { throw 'Extension ZIP version mismatch.' }
    if ($null -eq $archive.GetEntry('icons/icon-128.png')) { throw 'Extension ZIP must include its store icon.' }
} finally { $archive.Dispose() }

foreach ($directory in @($imageRoot, $documentRoot, $programRoot)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

function Convert-ScreenshotToPng([string]$imagePath) {
    $bytes = [System.IO.File]::ReadAllBytes($imagePath)
    $memory = [System.IO.MemoryStream]::new($bytes, $false)
    $source = [System.Drawing.Image]::FromStream($memory)
    try {
        if ($source.Width -ne 1280 -or $source.Height -ne 800) { throw 'Screenshots must be 1280x800.' }
        $rgb = [System.Drawing.Bitmap]::new(1280, 800, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        $graphics = [System.Drawing.Graphics]::FromImage($rgb)
        try {
            $graphics.Clear([System.Drawing.Color]::Black)
            $graphics.DrawImageUnscaled($source, 0, 0)
            $rgb.Save($imagePath, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $graphics.Dispose()
            $rgb.Dispose()
        }
    } finally {
        $source.Dispose()
        $memory.Dispose()
    }
}

function New-RoundedPath([single]$x, [single]$y, [single]$width, [single]$height, [single]$radius) {
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $diameter = $radius * 2
    $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
    $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
    $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function Draw-Label($graphics, [string]$text, [single]$size, [single]$x, [single]$y, [string]$color, [bool]$bold = $false) {
    $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
    $font = [System.Drawing.Font]::new('Microsoft YaHei UI', $size, $style, [System.Drawing.GraphicsUnit]::Pixel)
    $brush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($color))
    try { $graphics.DrawString($text, $font, $brush, $x, $y) }
    finally { $brush.Dispose(); $font.Dispose() }
}

function New-Promo([int]$width, [int]$height, [string]$filename) {
    $scale = 2
    $surface = [System.Drawing.Bitmap]::new($width * $scale, $height * $scale, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [System.Drawing.Graphics]::FromImage($surface)
    $icon = [System.Drawing.Image]::FromFile((Join-Path $extensionRoot 'icons\icon-128.png'))
    $panelBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#162c40'))
    $track = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#385267'), 6)
    $played = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#7ee2c3'), 6)
    $advert = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#ffce70'), 8)
    $jump = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#7ee2c3'), 3)
    try {
        $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#0c1828'))
        $graphics.ScaleTransform($scale, $scale)
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $track.StartCap = $track.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $played.StartCap = $played.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $advert.StartCap = $advert.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        if ($width -eq 440) {
            Draw-Label $graphics $copy.brand 35 30 35 '#f3fafb' $true
            Draw-Label $graphics $copy.tagline 18 33 87 '#9fb9c7'
            $graphics.DrawImage($icon, 291, 28, 116, 116)
            $panel = New-RoundedPath 24 155 392 101 18
            try { $graphics.FillPath($panelBrush, $panel) } finally { $panel.Dispose() }
            Draw-Label $graphics $copy.timeline 12 41 172 '#bfd3dd'
            $graphics.DrawLine($track, 44, 226, 394, 226)
            $graphics.DrawLine($played, 44, 226, 166, 226)
            $graphics.DrawLine($advert, 181, 226, 242, 226)
            $graphics.DrawBezier($jump, 169, 217, 177, 186, 242, 186, 255, 217)
            $graphics.DrawLine($jump, 255, 217, 245, 213)
            $graphics.DrawLine($jump, 255, 217, 256, 207)
        } else {
            Draw-Label $graphics $copy.brand 37 78 55 '#7ee2c3' $true
            Draw-Label $graphics $copy.marqueeTitle 66 73 132 '#f3fafb' $true
            Draw-Label $graphics $copy.features 25 82 254 '#a8bfcc'
            $graphics.DrawImage($icon, 1086, 69, 235, 235)
            $panel = New-RoundedPath 80 349 1240 139 24
            try { $graphics.FillPath($panelBrush, $panel) } finally { $panel.Dispose() }
            Draw-Label $graphics $copy.timeline 17 110 371 '#bfd3dd'
            $graphics.DrawLine($track, 116, 450, 1280, 450)
            $graphics.DrawLine($played, 116, 450, 596, 450)
            $graphics.DrawLine($advert, 624, 450, 788, 450)
            $graphics.DrawBezier($jump, 605, 434, 642, 343, 780, 343, 815, 434)
            $graphics.DrawLine($jump, 815, 434, 797, 427)
            $graphics.DrawLine($jump, 815, 434, 817, 415)
        }
        $output = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        $outputGraphics = [System.Drawing.Graphics]::FromImage($output)
        try {
            $outputGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $outputGraphics.DrawImage($surface, 0, 0, $width, $height)
            $output.Save((Join-Path $imageRoot $filename), [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $outputGraphics.Dispose()
            $output.Dispose()
        }
    } finally {
        $jump.Dispose()
        $advert.Dispose()
        $played.Dispose()
        $track.Dispose()
        $panelBrush.Dispose()
        $icon.Dispose()
        $graphics.Dispose()
        $surface.Dispose()
    }
}

foreach ($name in $screenshotNames) { Convert-ScreenshotToPng (Join-Path $assetRoot "screenshots\$name") }
Copy-Item -LiteralPath (Join-Path $extensionRoot 'icons\icon-128.png') -Destination (Join-Path $imageRoot 'icon-128.png') -Force
New-Promo 440 280 'promo-small-440x280.png'
New-Promo 1400 560 'promo-marquee-1400x560.png'

foreach ($name in @('store-listing.zh-CN.md', 'privacy-disclosures.md', 'reviewer-notes.md', 'screenshot-notes.md', 'privacy-policy.html')) {
    Copy-Item -LiteralPath (Join-Path $storeRoot $name) -Destination (Join-Path $documentRoot $name) -Force
}
Copy-Item -LiteralPath (Join-Path $storeRoot 'README.md') -Destination (Join-Path $assetRoot 'README.md') -Force
Copy-Item -LiteralPath $inputArchive -Destination $programRoot -Force
if (Test-Path -LiteralPath "$inputArchive.sha256") {
    Copy-Item -LiteralPath "$inputArchive.sha256" -Destination $programRoot -Force
}

$checksums = Get-ChildItem -LiteralPath $assetRoot -Recurse -File |
    Where-Object { $_.Name -ne 'SHA256SUMS.txt' } |
    Sort-Object FullName |
    ForEach-Object {
        $relative = $_.FullName.Substring($assetRoot.Length + 1).Replace('\', '/')
        $digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
        "$digest  $relative"
    }
[System.IO.File]::WriteAllText((Join-Path $assetRoot 'SHA256SUMS.txt'), (($checksums -join "`n") + "`n"), [System.Text.UTF8Encoding]::new($false))
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bundlePath = Join-Path $projectRoot "dist\biliskip-$version-store-materials-$stamp.zip"
$bundleStream = [System.IO.File]::Open($bundlePath, [System.IO.FileMode]::CreateNew)
$bundle = [System.IO.Compression.ZipArchive]::new($bundleStream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in (Get-ChildItem -LiteralPath $assetRoot -Recurse -File | Sort-Object FullName)) {
        $relative = $file.FullName.Substring($assetRoot.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($bundle, $file.FullName, $relative, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally {
    $bundle.Dispose()
    $bundleStream.Dispose()
}
$bundleHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $bundlePath).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText("$bundlePath.sha256", "$bundleHash  $([System.IO.Path]::GetFileName($bundlePath))`n", [System.Text.UTF8Encoding]::new($false))
Write-Output "Assets: $assetRoot"
Write-Output "Bundle: $bundlePath"
Write-Output "SHA256: $bundleHash"
