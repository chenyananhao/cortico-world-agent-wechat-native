# Installs this World into Coopanion's extensions folder.
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 [-ExtensionsDir <dir>] [-DryRun]
# It only adds: one dependency entry, one junction, one world-owners entry (with timestamped backups).
param(
  [string]$ExtensionsDir = 'D:\002Apps\Coopanion\data\extensions',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'cortico-world-agent-wechat-native'
$worldId = 'agentwechat'

if (-not (Test-Path $ExtensionsDir)) { throw "extensions dir not found: $ExtensionsDir" }
if (-not (Test-Path (Join-Path $source 'package.json'))) { throw "package.json not found next to install.ps1" }

$pkgFile = Join-Path $ExtensionsDir 'package.json'
$ownersFile = Join-Path $ExtensionsDir 'world-owners.json'
$link = Join-Path $ExtensionsDir "node_modules\$name"
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# Relative link spec, so the install survives a moved data folder.
# (PS 5.1 has no [IO.Path]::GetRelativePath; Uri handles it. Across drives it can only be absolute.)
$baseUri = [Uri]((Resolve-Path $ExtensionsDir).Path.TrimEnd('\') + '\')
$targetUri = [Uri]((Resolve-Path $source).Path.TrimEnd('\') + '\')
$relative = $baseUri.MakeRelativeUri($targetUri).ToString() -replace '\\', '/'
if ($relative -match '^[A-Za-z]:') { $relative = (Resolve-Path $source).Path -replace '\\', '/' }

Write-Host "extension dir : $ExtensionsDir"
Write-Host "source        : $source"
Write-Host "link spec     : link:$relative"
if ($DryRun) {
  Write-Host "DRY RUN: nothing written"
  return
}

Copy-Item $pkgFile "$pkgFile.bak-$stamp"
if (Test-Path $ownersFile) { Copy-Item $ownersFile "$ownersFile.bak-$stamp" }
Write-Host "backup        : package.json.bak-$stamp"

$pkg = Get-Content $pkgFile -Raw | ConvertFrom-Json
if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
$pkg.dependencies | Add-Member -NotePropertyName $name -NotePropertyValue "link:$relative" -Force
($pkg | ConvertTo-Json -Depth 8) | Set-Content $pkgFile -Encoding UTF8
Write-Host "dependency    : added"

if (Test-Path $ownersFile) {
  $owners = Get-Content $ownersFile -Raw | ConvertFrom-Json
  $owners | Add-Member -NotePropertyName $worldId -NotePropertyValue $name -Force
  ($owners | ConvertTo-Json -Depth 8) | Set-Content $ownersFile -Encoding UTF8
  Write-Host "world-owners  : $worldId -> $name"
}

if (Test-Path $link) {
  $existing = (Get-Item $link).Target
  if ($existing -and ($existing | Select-Object -First 1) -ne $source) {
    Write-Host "relinking     : was $existing"
    cmd /c rmdir "$link"
  } else {
    Write-Host "junction      : already pointing at source"
    return
  }
}
cmd /c mklink /J "$link" "$source" | Out-Null
Write-Host "junction      : created"
Write-Host ""
Write-Host "Done. Restart Coopanion, then enable 'NAS WeChat' (worlds.agentwechat)."
