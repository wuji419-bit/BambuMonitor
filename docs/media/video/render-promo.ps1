$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
Set-Location $repoRoot

$ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source
$videoDir = 'docs/media/video'
$screens = 'docs/screenshots'

function Invoke-Ffmpeg([string[]]$Arguments) {
  & $ffmpeg @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "ffmpeg failed with exit code $LASTEXITCODE"
  }
}

function New-Slideshow([string]$Cover, [string]$Output) {
  $images = @(
    $Cover,
    "$screens/dashboard.png",
    "$screens/compact.png",
    "$screens/mini.png",
    "$screens/camera-wall.png",
    "$screens/camera-zoom.png",
    "$screens/settings.png",
    $Cover
  )

  $arguments = @('-y')
  foreach ($image in $images) {
    $arguments += @('-loop', '1', '-framerate', '30', '-t', '4.25', '-i', $image)
  }

  $filters = [System.Collections.Generic.List[string]]::new()
  for ($index = 0; $index -lt $images.Count; $index += 1) {
    $filters.Add("[$index`:v]split=2[b$index][f$index]")
    $filters.Add("[b$index]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=28:4,eq=brightness=-0.38[bg$index]")
    $filters.Add("[f$index]scale=1920:1080:force_original_aspect_ratio=decrease[fg$index]")
    $filters.Add("[bg$index][fg$index]overlay=(W-w)/2:(H-h)/2,format=yuv420p,setsar=1,setpts=PTS-STARTPTS[v$index]")
  }

  $previous = 'v0'
  for ($index = 1; $index -lt $images.Count; $index += 1) {
    $outputLabel = "x$index"
    $offset = (3.75 * $index).ToString('0.00', [Globalization.CultureInfo]::InvariantCulture)
    $filters.Add("[$previous][v$index]xfade=transition=fade:duration=0.5:offset=$offset[$outputLabel]")
    $previous = $outputLabel
  }

  $arguments += @(
    '-filter_complex', ($filters -join ';'),
    '-map', "[$previous]",
    '-t', '30',
    '-r', '30',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    $Output
  )
  Invoke-Ffmpeg $arguments
}

function New-FinalVideo(
  [string]$BaseVideo,
  [string]$Voice,
  [string]$Subtitle,
  [string]$FontName,
  [string]$Output
) {
  $subtitleFilter = "[0:v]subtitles=filename='$Subtitle':force_style='FontName=$FontName,FontSize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&HCC07101A,BorderStyle=1,Outline=1.5,Shadow=0,Alignment=2,MarginV=18'[v]"
  $audioFilter = '[1:a]volume=1.15,apad=pad_dur=2,atrim=0:30[voice];[2:a]volume=0.42[music];[voice][music]amix=inputs=2:duration=longest:dropout_transition=1.5[a]'
  Invoke-Ffmpeg @(
    '-y',
    '-i', $BaseVideo,
    '-i', $Voice,
    '-i', "$videoDir/ambient-tech.wav",
    '-filter_complex', "$subtitleFilter;$audioFilter",
    '-map', '[v]',
    '-map', '[a]',
    '-t', '30',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '19',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    $Output
  )
}

Invoke-Ffmpeg @(
  '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=110:sample_rate=48000:duration=30',
  '-f', 'lavfi', '-i', 'sine=frequency=165:sample_rate=48000:duration=30',
  '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=30',
  '-filter_complex', '[0:a]volume=0.055,tremolo=f=0.12:d=0.3[a0];[1:a]volume=0.025,tremolo=f=0.10:d=0.25[a1];[2:a]volume=0.012,tremolo=f=0.10:d=0.2[a2];[a0][a1][a2]amix=inputs=3:duration=longest,lowpass=f=1800,aecho=0.8:0.35:90:0.18,afade=t=in:st=0:d=1.2,afade=t=out:st=28:d=2[music]',
  '-map', '[music]',
  '-c:a', 'pcm_s16le',
  "$videoDir/ambient-tech.wav"
)

Invoke-Ffmpeg @('-y', '-i', "$videoDir/bambu-monitor-cover-1280.png", '-vf', 'scale=1920:1080:flags=lanczos', "$videoDir/bambu-monitor-cover.png")
Invoke-Ffmpeg @('-y', '-i', "$videoDir/bambu-monitor-cover-en-1280.png", '-vf', 'scale=1920:1080:flags=lanczos', "$videoDir/bambu-monitor-cover-en.png")

New-Slideshow "$videoDir/bambu-monitor-cover-1280.png" "$videoDir/base-zh.mp4"
New-Slideshow "$videoDir/bambu-monitor-cover-en-1280.png" "$videoDir/base-en.mp4"

New-FinalVideo "$videoDir/base-zh.mp4" "$videoDir/bambu-monitor-zh.mp3" "$videoDir/bambu-monitor-zh.srt" 'Microsoft YaHei' "$videoDir/bambu-monitor-bilibili-zh.mp4"
New-FinalVideo "$videoDir/base-en.mp4" "$videoDir/bambu-monitor-en.mp3" "$videoDir/bambu-monitor-en.srt" 'Segoe UI' "$videoDir/bambu-monitor-bilibili-en.mp4"

Remove-Item "$videoDir/base-zh.mp4", "$videoDir/base-en.mp4", "$videoDir/ambient-tech.wav" -Force
