# Create or reuse this repository's .venv-overture with the downloader
# requirements, using the setup script that ships with the add-on.
[CmdletBinding()]
param(
    [Parameter()]
    [string]$Python = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$Setup = Join-Path $ProjectRoot "jarvizar_city_model\setup\setup_downloader.ps1"
& $Setup -VenvPath (Join-Path $ProjectRoot ".venv-overture") -Python $Python
exit $LASTEXITCODE
