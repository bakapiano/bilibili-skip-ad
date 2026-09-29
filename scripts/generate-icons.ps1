$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$iconRoot = Join-Path $projectRoot 'extension\icons'
New-Item -ItemType Directory -Path $iconRoot -Force | Out-Null

# Code-drawn skip symbol: teal tile, white play arrow and gold ad-end marker.
# The store's 128px icon uses a 96px tile with 16px transparent padding.
foreach ($size in @(16, 32, 48, 128)) {
    $scale = 4
    $bitmap = [System.Drawing.Bitmap]::new($size * $scale, $size * $scale)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $tile = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $background = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#107d6b'))
    $foreground = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#f4fffc'))
    $accent = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#ffce70'))
    try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.ScaleTransform($size * $scale / 128.0, $size * $scale / 128.0)
        if ($size -lt 128) {
            # Smaller toolbar icons keep more visual weight.
            $graphics.TranslateTransform(-16.0, -16.0)
            $graphics.ScaleTransform(1.25, 1.25)
        }
        $tile.AddArc(16, 16, 36, 36, 180, 90)
        $tile.AddArc(76, 16, 36, 36, 270, 90)
        $tile.AddArc(76, 76, 36, 36, 0, 90)
        $tile.AddArc(16, 76, 36, 36, 90, 90)
        $tile.CloseFigure()
        $graphics.FillPath($background, $tile)
        $triangle = [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(40, 36),
            [System.Drawing.PointF]::new(40, 78),
            [System.Drawing.PointF]::new(73, 57)
        )
        $graphics.FillPolygon($foreground, $triangle)
        $graphics.FillRectangle($accent, 79, 36, 9, 42)
        $graphics.FillRectangle($foreground, 36, 90, 27, 5)
        $graphics.FillRectangle($accent, 67, 90, 25, 5)

        $output = [System.Drawing.Bitmap]::new($size, $size)
        $outputGraphics = [System.Drawing.Graphics]::FromImage($output)
        try {
            $outputGraphics.Clear([System.Drawing.Color]::Transparent)
            $outputGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $outputGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $outputGraphics.DrawImage($bitmap, 0, 0, $size, $size)
            $output.Save((Join-Path $iconRoot "icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $outputGraphics.Dispose()
            $output.Dispose()
        }
    } finally {
        $accent.Dispose()
        $foreground.Dispose()
        $background.Dispose()
        $tile.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}
Write-Output "Generated extension icons: $iconRoot"
