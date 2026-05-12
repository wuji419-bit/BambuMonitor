Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$buildDir = Join-Path $root 'build'
$publicDir = Join-Path $root 'public'
$previewPath = Join-Path $root 'bambu-icon-small-preview.png'

New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
New-Item -ItemType Directory -Force -Path $publicDir | Out-Null

function New-RoundedRectPath {
  param(
    [System.Drawing.RectangleF]$Rect,
    [float]$Radius
  )

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $Radius * 2
  $path.AddArc($Rect.X, $Rect.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($Rect.Right - $diameter, $Rect.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($Rect.Right - $diameter, $Rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($Rect.X, $Rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-IconBitmap {
  param([int]$Size)

  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $pad = [Math]::Max(1, [Math]::Round($Size * 0.05))
  $rect = [System.Drawing.RectangleF]::new($pad, $pad, $Size - ($pad * 2), $Size - ($pad * 2))
  $radius = [Math]::Max(3, $Size * 0.2)
  $bgPath = New-RoundedRectPath -Rect $rect -Radius $radius
  $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 137, 246, 210)), ([System.Drawing.Color]::FromArgb(255, 61, 140, 255)), 135
  $graphics.FillPath($bgBrush, $bgPath)

  $borderWidth = [Math]::Max(1, [Math]::Round($Size * 0.025))
  $borderPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(92, 255, 255, 255)), $borderWidth
  $graphics.DrawPath($borderPen, $bgPath)

  $dark = [System.Drawing.Color]::FromArgb(255, 11, 38, 52)
  $trackPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(52, 16, 48, 65)), ([Math]::Max(2, $Size * 0.08))
  $trackPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $trackPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $progressPen = New-Object System.Drawing.Pen $dark, ([Math]::Max(2, $Size * 0.08))
  $progressPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $progressPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $ringPad = $Size * 0.25
  $ringRect = [System.Drawing.RectangleF]::new($ringPad, $Size * 0.23, $Size - ($ringPad * 2), $Size - ($ringPad * 2))
  if ($Size -ge 24) {
    $graphics.DrawArc($trackPen, $ringRect, -90, 360)
    $graphics.DrawArc($progressPen, $ringRect, -98, 270)
  }

  $centerBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(246, 247, 255, 252))
  $centerSize = $Size * 0.34
  $graphics.FillEllipse($centerBrush, ($Size - $centerSize) / 2, $Size * 0.32, $centerSize, $centerSize)

  $shapeBrush = New-Object System.Drawing.SolidBrush $dark
  $headW = $Size * 0.25
  $headH = $Size * 0.11
  $headX = ($Size - $headW) / 2
  $headY = $Size * 0.38
  $headPath = New-RoundedRectPath -Rect ([System.Drawing.RectangleF]::new($headX, $headY, $headW, $headH)) -Radius ([Math]::Max(1, $headH * 0.35))
  $graphics.FillPath($shapeBrush, $headPath)

  $nozzle = New-Object System.Drawing.Drawing2D.GraphicsPath
  $nozzle.AddPolygon(@(
    [System.Drawing.PointF]::new($Size * 0.42, $Size * 0.48),
    [System.Drawing.PointF]::new($Size * 0.58, $Size * 0.48),
    [System.Drawing.PointF]::new($Size * 0.54, $Size * 0.61),
    [System.Drawing.PointF]::new($Size * 0.46, $Size * 0.61)
  ))
  $graphics.FillPath($shapeBrush, $nozzle)
  $tip = New-Object System.Drawing.Drawing2D.GraphicsPath
  $tip.AddPolygon(@(
    [System.Drawing.PointF]::new($Size * 0.47, $Size * 0.61),
    [System.Drawing.PointF]::new($Size * 0.53, $Size * 0.61),
    [System.Drawing.PointF]::new($Size * 0.50, $Size * 0.70)
  ))
  $graphics.FillPath($shapeBrush, $tip)

  if ($Size -ge 32) {
    $barW = $Size * 0.36
    $barH = [Math]::Max(2, $Size * 0.055)
    $barX = ($Size - $barW) / 2
    $barY = $Size * 0.72
    $barPath = New-RoundedRectPath -Rect ([System.Drawing.RectangleF]::new($barX, $barY, $barW, $barH)) -Radius ($barH / 2)
    $graphics.FillPath($shapeBrush, $barPath)
    $dotBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 247, 255, 252))
    $dot = $barH
    $graphics.FillEllipse($dotBrush, $barX + $barW - $dot, $barY, $dot, $dot)
    $dotBrush.Dispose()
    $barPath.Dispose()
  }

  $tip.Dispose()
  $nozzle.Dispose()
  $headPath.Dispose()
  $shapeBrush.Dispose()
  $centerBrush.Dispose()
  $progressPen.Dispose()
  $trackPen.Dispose()
  $borderPen.Dispose()
  $bgBrush.Dispose()
  $bgPath.Dispose()
  $graphics.Dispose()

  return $bitmap
}

function Save-Png {
  param(
    [System.Drawing.Bitmap]$Bitmap,
    [string]$Path
  )

  $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Save-Ico {
  param(
    [int[]]$Sizes,
    [string]$Path
  )

  $pngItems = @()
  foreach ($size in $Sizes) {
    $bitmap = New-IconBitmap -Size $size
    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngItems += [PSCustomObject]@{ Size = $size; Data = $stream.ToArray() }
    $stream.Dispose()
    $bitmap.Dispose()
  }

  $file = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create)
  $writer = New-Object System.IO.BinaryWriter $file
  $writer.Write([UInt16]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]$pngItems.Count)

  $offset = 6 + (16 * $pngItems.Count)
  foreach ($item in $pngItems) {
    $sizeByte = if ($item.Size -eq 256) { 0 } else { $item.Size }
    $writer.Write([byte]$sizeByte)
    $writer.Write([byte]$sizeByte)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$item.Data.Length)
    $writer.Write([UInt32]$offset)
    $offset += $item.Data.Length
  }

  foreach ($item in $pngItems) {
    $writer.Write($item.Data)
  }

  $writer.Dispose()
  $file.Dispose()
}

$icon1024 = New-IconBitmap -Size 1024
Save-Png -Bitmap $icon1024 -Path (Join-Path $buildDir 'icon.png')
$icon1024.Dispose()

$tray = New-IconBitmap -Size 256
Save-Png -Bitmap $tray -Path (Join-Path $publicDir 'tray-icon.png')
$tray.Dispose()

Save-Ico -Sizes @(16, 24, 32, 48, 64, 128, 256) -Path (Join-Path $buildDir 'icon.ico')

$sizes = @(16, 24, 32, 48, 64)
$previewWidth = 12 + (($sizes | Measure-Object -Sum).Sum) + (($sizes.Count - 1) * 16)
$previewHeight = 90
$preview = New-Object System.Drawing.Bitmap $previewWidth, $previewHeight, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($preview)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(255, 241, 246, 250))
$x = 8
foreach ($size in $sizes) {
  $bitmap = New-IconBitmap -Size $size
  $graphics.DrawImage($bitmap, $x, 14, $size, $size)
  $labelFont = New-Object System.Drawing.Font 'Segoe UI', 10, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $labelBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 20, 32, 45))
  $graphics.DrawString("${size}px", $labelFont, $labelBrush, $x - 1, 70)
  $labelBrush.Dispose()
  $labelFont.Dispose()
  $bitmap.Dispose()
  $x += $size + 16
}
$graphics.Dispose()
Save-Png -Bitmap $preview -Path $previewPath
$preview.Dispose()

Write-Output "Generated icon assets:"
Write-Output (Join-Path $buildDir 'icon.png')
Write-Output (Join-Path $buildDir 'icon.ico')
Write-Output (Join-Path $publicDir 'tray-icon.png')
Write-Output $previewPath
