# Recreate the NSIS artwork from Copilotix's app icon, in the home page's cipher-field style:
# installer-sidebar.bmp (164x314, welcome/finish pages) and installer-header.bmp (150x57, inner pages).
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$resources = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../resources'))
$icon = [Drawing.Image]::FromFile((Join-Path $resources 'icon.png'))
$pool = 'abcdefghijklmnopqrstuvwxyz0123456789+-=<>/\|:;.'
$scramble = '#%&*+=<>/\|$@?ABDEFGHJKMNQRSUVWYZ0123456789'
# Fixed seed: the artwork is reproducible.
$random = New-Object Random 20261014

function Color([string]$hex, [int]$alpha = 255) {
    $c = [Drawing.ColorTranslator]::FromHtml($hex)
    [Drawing.Color]::FromArgb($alpha, $c.R, $c.G, $c.B)
}

# A field of faint monospace glyphs on a fixed grid, with a decryption ring crossing it in the accent.
function Draw-Field($graphics, [int]$width, [int]$height, [string]$ink, [string]$accent, [double]$ringX, [double]$ringY, [double]$ringRadius, [int]$baseAlpha) {
    $font = New-Object Drawing.Font('Consolas', 9, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
    try {
        for ($y = 4; $y -lt $height; $y += 10) {
            for ($x = 2; $x -lt $width; $x += 6) {
                $distance = [Math]::Abs([Math]::Sqrt(($x - $ringX) * ($x - $ringX) + ($y - $ringY) * ($y - $ringY)) - $ringRadius)
                if ($distance -lt 7) {
                    $alpha = [int](230 * (1 - $distance / 7))
                    $brush = New-Object Drawing.SolidBrush (Color $accent $alpha)
                    $glyph = $scramble[$random.Next($scramble.Length)]
                } elseif ($random.NextDouble() -lt 0.42) {
                    $brush = New-Object Drawing.SolidBrush (Color $ink ($baseAlpha + $random.Next($baseAlpha)))
                    $glyph = $pool[$random.Next($pool.Length)]
                } else { continue }
                $graphics.DrawString([string]$glyph, $font, $brush, [single]$x, [single]$y)
                $brush.Dispose()
            }
        }
    } finally { $font.Dispose() }
}

# The icon is black line art on white; on the dark sidebar it is redrawn as a cream mark on transparency.
function New-InkMark($source, [int]$size, [string]$hex) {
    $scaled = New-Object Drawing.Bitmap -ArgumentList $source, $size, $size
    $mark = New-Object Drawing.Bitmap($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $tone = Color $hex
    for ($y = 0; $y -lt $size; $y++) {
        for ($x = 0; $x -lt $size; $x++) {
            $pixel = $scaled.GetPixel($x, $y)
            $coverage = [int]((255 - ($pixel.R + $pixel.G + $pixel.B) / 3) * $pixel.A / 255)
            $mark.SetPixel($x, $y, [Drawing.Color]::FromArgb($coverage, $tone.R, $tone.G, $tone.B))
        }
    }
    $scaled.Dispose()
    $mark
}

function New-Canvas([int]$width, [int]$height) {
    $bitmap = New-Object Drawing.Bitmap($width, $height, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    @($bitmap, $graphics)
}

# Sidebar: night paper, the field, the icon on a soft halo, the name and an ink rule with its square.
$bitmap, $graphics = New-Canvas 164 314
try {
    $graphics.Clear((Color '#1b1916'))
    Draw-Field $graphics 164 314 '#f1eadf' '#9693f5' -40 120 150 20
    $veil = New-Object Drawing.Drawing2D.LinearGradientBrush([Drawing.Rectangle]::new(0, 120, 164, 194), (Color '#1b1916' 0), (Color '#1b1916' 235), 90)
    $graphics.FillRectangle($veil, 0, 120, 164, 194)
    $veil.Dispose()
    $halo = New-Object Drawing.Drawing2D.GraphicsPath
    $halo.AddEllipse(22, 38, 120, 120)
    $glow = New-Object Drawing.Drawing2D.PathGradientBrush($halo)
    $glow.CenterColor = Color '#9693f5' 55
    $glow.SurroundColors = @((Color '#9693f5' 0))
    $graphics.FillPath($glow, $halo)
    $glow.Dispose(); $halo.Dispose()
    $mark = New-InkMark $icon 80 '#f1eadf'
    $graphics.DrawImage($mark, 42, 58, 80, 80)
    $mark.Dispose()
    $title = New-Object Drawing.Font('Segoe UI Semibold', 20, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
    $caption = New-Object Drawing.Font('Segoe UI', 9, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
    $eyebrow = New-Object Drawing.Font('Consolas', 8, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
    $center = New-Object Drawing.StringFormat
    $center.Alignment = [Drawing.StringAlignment]::Center
    $cream = New-Object Drawing.SolidBrush (Color '#f1eadf')
    $muted = New-Object Drawing.SolidBrush (Color '#999082')
    $accent = New-Object Drawing.SolidBrush (Color '#9693f5')
    $rule = New-Object Drawing.Pen((Color '#f1eadf' 120), 1)
    try {
        $graphics.DrawString('Copilotix', $title, $cream, [Drawing.RectangleF]::new(0, 168, 164, 30), $center)
        $graphics.DrawLine($rule, 38, 206, 126, 206)
        $graphics.FillRectangle($accent, 34, 204, 5, 5)
        $graphics.DrawString('READ / TRANSLATE / EXPLORE', $caption, $muted, [Drawing.RectangleF]::new(0, 214, 164, 18), $center)
        $graphics.DrawString('PAPER ARCHIVE / SETUP', $eyebrow, $muted, [Drawing.RectangleF]::new(0, 288, 164, 14), $center)
    } finally {
        $rule.Dispose(); $accent.Dispose(); $muted.Dispose(); $cream.Dispose(); $center.Dispose()
        $eyebrow.Dispose(); $caption.Dispose(); $title.Dispose()
    }
    $bitmap.Save((Join-Path $resources 'installer-sidebar.bmp'), [Drawing.Imaging.ImageFormat]::Bmp)
} finally { $graphics.Dispose(); $bitmap.Dispose() }

# Header: the wizard's white strip, a fading line of glyphs, the icon and an accent tick.
$bitmap, $graphics = New-Canvas 150 57
try {
    $graphics.Clear((Color '#ffffff'))
    Draw-Field $graphics 150 57 '#2f2a24' '#5b58d6' 170 28 70 14
    $veil = New-Object Drawing.Drawing2D.LinearGradientBrush([Drawing.Rectangle]::new(0, 0, 150, 57), (Color '#ffffff' 250), (Color '#ffffff' 40), 0)
    $graphics.FillRectangle($veil, 0, 0, 150, 57)
    $veil.Dispose()
    $graphics.DrawImage($icon, 104, 10, 36, 36)
    $accent = New-Object Drawing.SolidBrush (Color '#5b58d6')
    $graphics.FillRectangle($accent, 104, 50, 36, 2)
    $accent.Dispose()
    $bitmap.Save((Join-Path $resources 'installer-header.bmp'), [Drawing.Imaging.ImageFormat]::Bmp)
} finally { $graphics.Dispose(); $bitmap.Dispose() }
$icon.Dispose()
