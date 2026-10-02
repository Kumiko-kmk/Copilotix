# Recreate the NSIS welcome/finish artwork from Copilotix's existing app icon.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$resources = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../resources'))
$bitmap = New-Object Drawing.Bitmap(164, 314, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$icon = [Drawing.Image]::FromFile((Join-Path $resources 'icon.png'))
$ink = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#262626'))
$muted = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#736e65'))
$font = New-Object Drawing.Font('Segoe UI', 18, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
$caption = New-Object Drawing.Font('Segoe UI', 10, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
$format = New-Object Drawing.StringFormat
$format.Alignment = [Drawing.StringAlignment]::Center
try {
    $graphics.Clear([Drawing.ColorTranslator]::FromHtml('#f7f2e8'))
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.DrawImage($icon, 34, 57, 96, 96)
    $graphics.DrawString('Copilotix', $font, $ink, [Drawing.RectangleF]::new(0, 175, 164, 30), $format)
    $graphics.DrawString('Read. Translate. Explore.', $caption, $muted, [Drawing.RectangleF]::new(0, 209, 164, 22), $format)
    $bitmap.Save((Join-Path $resources 'installer-sidebar.bmp'), [Drawing.Imaging.ImageFormat]::Bmp)
} finally {
    $format.Dispose(); $caption.Dispose(); $font.Dispose(); $muted.Dispose(); $ink.Dispose()
    $icon.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
