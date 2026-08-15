[CmdletBinding()]
param(
  [switch]$Remove,
  [string]$StartupDirectory = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($StartupDirectory)) {
  $StartupDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
}

if (-not (Test-Path -LiteralPath $StartupDirectory)) {
  New-Item -ItemType Directory -Path $StartupDirectory | Out-Null
}

$shortcutPath = Join-Path $StartupDirectory "Seth Haynes Photography Publisher.lnk"
if ($Remove) {
  Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
  Write-Output "Removed publisher startup shortcut: $shortcutPath"
  exit 0
}

$repository = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$launcher = (Resolve-Path (Join-Path $PSScriptRoot "start-background.mjs")).Path
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$escapedNode = $nodePath.Replace("'", "''")
$escapedLauncher = $launcher.Replace("'", "''")
$command = "& '$escapedNode' '$escapedLauncher'"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powerShellPath
$shortcut.Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"$command`""
$shortcut.WorkingDirectory = $repository
$shortcut.WindowStyle = 7
$shortcut.Description = "Start the Seth Haynes Photography publisher in the background"
$shortcut.Save()

Write-Output "Installed publisher startup shortcut: $shortcutPath"
