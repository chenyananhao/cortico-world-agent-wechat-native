<#
.SYNOPSIS
  Install the agentwechat multi-session patch into the local Coopanion install, keeping backups.

.DESCRIPTION
  The patch touches five files:
    build/cortico/src/core/{core,loop,state,types}.ts   per-session assembly and delivery routing
    core/persona.ts                                     on-demand session declaration
  Core runs the .ts sources directly via `--import tsx`, so a restart is enough; no build step.
  Installing while Coopanion runs is safe: the new code takes effect on the next start.

.PARAMETER AppRoot
  Coopanion's resources\app directory.

.PARAMETER BackupRoot
  Backup directory; defaults to backups\<timestamp> next to this script.

.PARAMETER DryRun
  Print the plan without writing anything.
#>
[CmdletBinding()]
param(
  [string]$AppRoot = 'D:\002Apps\Coopanion\resources\app',
  [string]$BackupRoot,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$filesRoot = Join-Path $here 'files'
if (-not $BackupRoot) {
  $BackupRoot = Join-Path $here (Join-Path 'backups' (Get-Date -Format 'yyyyMMdd-HHmmss'))
}

$targets = @(
  @{ Patch = 'build\cortico\src\core\core.ts';  App = 'build\cortico\src\core\core.ts' },
  @{ Patch = 'build\cortico\src\core\loop.ts';  App = 'build\cortico\src\core\loop.ts' },
  @{ Patch = 'build\cortico\src\core\state.ts'; App = 'build\cortico\src\core\state.ts' },
  @{ Patch = 'build\cortico\src\core\types.ts'; App = 'build\cortico\src\core\types.ts' },
  @{ Patch = 'app\core\persona.ts';             App = 'core\persona.ts' }
)

if (-not (Test-Path $AppRoot)) { throw "Coopanion app dir not found: $AppRoot" }

$plan = foreach ($t in $targets) {
  $src = Join-Path $filesRoot $t.Patch
  $dst = Join-Path $AppRoot $t.App
  if (-not (Test-Path $src)) { throw "patch file missing: $src" }
  if (-not (Test-Path $dst)) { throw "target file missing (version mismatch?): $dst" }
  [pscustomobject]@{ Rel = $t.App; Src = $src; Dst = $dst }
}

$plan | ForEach-Object { "install  $($_.Rel)" }
if ($DryRun) { 'dry run: nothing written'; return }

New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
foreach ($item in $plan) {
  $backup = Join-Path $BackupRoot $item.Rel
  New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
  Copy-Item -LiteralPath $item.Dst -Destination $backup -Force
  $before = (Get-FileHash -LiteralPath $item.Dst -Algorithm SHA256).Hash
  Copy-Item -LiteralPath $item.Src -Destination $item.Dst -Force
  $after = (Get-FileHash -LiteralPath $item.Dst -Algorithm SHA256).Hash
  "installed $($item.Rel)  $($before.Substring(0,12)) -> $($after.Substring(0,12))"
}

"backup dir: $BackupRoot"
'Restart Coopanion to activate. Rollback: copy the backup files back over the same relative paths.'
