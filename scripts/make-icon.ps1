# 诗窗快捷方式图标。朱色实心印、米色字，经典 BMP 格式，桌面不易被缓存成空框。
Add-Type -AssemblyName System.Drawing

$paper = [System.Drawing.Color]::FromArgb(255, 243, 238, 228)
$cinnabar = [System.Drawing.Color]::FromArgb(255, 143, 61, 54)

$fontName = "KaiTi"
$hasKai = [System.Drawing.FontFamily]::Families | Where-Object { $_.Name -eq "KaiTi" }
if (-not $hasKai) { $fontName = "SimSun" }
$style = [System.Drawing.FontStyle]::Regular
$unit = [System.Drawing.GraphicsUnit]::Pixel

function Draw-Seal([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  if ($size -le 16) {
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit
  } else {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  }

  $pad = if ($size -le 16) { 0 } else { [Math]::Max(1, [int][Math]::Round($size * 0.04)) }
  $fill = New-Object System.Drawing.SolidBrush $cinnabar
  $g.FillRectangle($fill, $pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad))

  if ($size -ge 32) {
    $inner = $pad + [Math]::Max(2, [int][Math]::Round($size * 0.08))
    $stroke = [Math]::Max(1.0, $size * 0.018)
    $pen = New-Object System.Drawing.Pen $paper, $stroke
    $g.DrawRectangle($pen, $inner, $inner, ($size - 2 * $inner - 1), ($size - 2 * $inner - 1))
    $pen.Dispose()
  }

  if ($size -le 16) {
    $drawFont = "SimSun"
    $fontSize = 12
    $hasSong = [System.Drawing.FontFamily]::Families | Where-Object { $_.Name -eq "SimSun" }
    if (-not $hasSong) { $drawFont = $fontName; $fontSize = 11 }
  } else {
    $drawFont = $fontName
    $fontSize = [single]($size * 0.52)
  }
  $font = New-Object System.Drawing.Font($drawFont, ([single]$fontSize), $style, $unit)
  $brush = New-Object System.Drawing.SolidBrush $paper
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $nudge = if ($size -le 16) { 0 } else { $size * 0.02 }
  $rect = New-Object System.Drawing.RectangleF 0, $nudge, $size, $size
  $g.DrawString([string][char]0x8BD7, $font, $brush, $rect, $format)

  $g.Dispose()
  $font.Dispose()
  $brush.Dispose()
  $fill.Dispose()
  return $bmp
}

function Bmp-Entry([System.Drawing.Bitmap]$bmp) {
  $w = $bmp.Width
  $h = $bmp.Height
  $xorStride = $w * 4
  $andStride = (($w + 31) -band (-bnot 31)) / 8
  $xorSize = $xorStride * $h
  $andSize = $andStride * $h
  $headerSize = 40
  $total = $headerSize + $xorSize + $andSize
  $bytes = New-Object byte[] $total
  $ms = New-Object System.IO.MemoryStream($bytes, $true)
  $bw = New-Object System.IO.BinaryWriter $ms

  $bw.Write([UInt32]$headerSize)
  $bw.Write([Int32]$w)
  $bw.Write([Int32](2 * $h))
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]32)
  $bw.Write([UInt32]0)
  $bw.Write([UInt32]($xorSize + $andSize))
  $bw.Write([Int32]0)
  $bw.Write([Int32]0)
  $bw.Write([UInt32]0)
  $bw.Write([UInt32]0)

  for ($y = $h - 1; $y -ge 0; $y--) {
    for ($x = 0; $x -lt $w; $x++) {
      $c = $bmp.GetPixel($x, $y)
      $bw.Write([byte]$c.B)
      $bw.Write([byte]$c.G)
      $bw.Write([byte]$c.R)
      $bw.Write([byte]$c.A)
    }
  }

  $and = New-Object byte[] $andSize
  $bw.Write($and)
  $bw.Flush()
  $bw.Dispose()
  $ms.Dispose()
  return ,$bytes
}

$sizes = @(16, 32, 48, 256)
$images = @()
foreach ($size in $sizes) {
  $bmp = Draw-Seal $size
  if ($size -eq 256) {
    $preview = Join-Path $PSScriptRoot "shichuang-preview.png"
    $bmp.Save($preview, [System.Drawing.Imaging.ImageFormat]::Png)
  }
  $images += ,(Bmp-Entry $bmp)
  $bmp.Dispose()
}

$icoPath = Join-Path $PSScriptRoot "shichuang.ico"
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$images.Count)
$offset = 6 + (16 * $images.Count)
for ($i = 0; $i -lt $images.Count; $i++) {
  $side = $sizes[$i]
  $chunk = [byte[]]$images[$i]
  $bw.Write([byte]$(if ($side -ge 256) { 0 } else { $side }))
  $bw.Write([byte]$(if ($side -ge 256) { 0 } else { $side }))
  $bw.Write([byte]0)
  $bw.Write([byte]0)
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]32)
  $bw.Write([UInt32]$chunk.Length)
  $bw.Write([UInt32]$offset)
  $offset += $chunk.Length
}
foreach ($item in $images) {
  $chunk = [byte[]]$item
  $bw.BaseStream.Write($chunk, 0, $chunk.Length)
}
$bw.Flush()
$bw.Dispose()
$fs.Dispose()
Write-Output "ico=$icoPath font=$fontName sizes=$($sizes -join ',') bytes=$((Get-Item $icoPath).Length)"
