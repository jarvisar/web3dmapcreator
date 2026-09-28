# Create or update the separate Python environment that the Jarvizar City
# Model add-on uses to download map data. Blender's own Python is not changed.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup_downloader.ps1 [options]
#
#   -WithLidar     Also install the optional LiDAR building packages.
#   -Python PATH   Create the environment with this Python 3.10 or newer.
#   -VenvPath DIR  Environment folder. Default:
#                  %LOCALAPPDATA%\JarvizarCityModel\downloader-venv
#   -SkipInstall   Create the environment but do not run pip (for testing).
#
# Running it again updates the packages; an environment that no longer runs
# is recreated. The last line printed is the interpreter path.

[CmdletBinding()]
param(
    [string]$Python = "",
    [string]$VenvPath = "",
    [switch]$WithLidar,
    [switch]$SkipInstall
)

Set-StrictMode -Version 2.0
# Native programs report failure through exit codes, which are checked below.
# "Stop" would also turn their stderr into terminating errors in Windows
# PowerShell 5.1 whenever the output is redirected.
$ErrorActionPreference = "Continue"

$SetupDir = $PSScriptRoot
$DownloaderRequirements = Join-Path $SetupDir "requirements-downloader.txt"
$LidarRequirements = Join-Path $SetupDir "requirements-lidar.txt"
$PreferredVersions = @("3.11", "3.12", "3.13", "3.10")
$MinimumVersion = [version]"3.10"
$VersionCode = "import sys; print('%d.%d.%d' % sys.version_info[:3]); print(sys.executable)"

function Stop-Setup([string]$Message) {
    Write-Host ""
    Write-Host "Setup failed: $Message" -ForegroundColor Red
    exit 1
}

# Output and exit code of a command, with its error output discarded.
function Invoke-Quiet([string]$Exe, [string[]]$Arguments) {
    try {
        $output = @(& $Exe @Arguments 2>$null)
        $code = $LASTEXITCODE
    }
    catch {
        $output = @()
        $code = 1
    }
    return @{ Code = $code; Output = $output }
}

# Version and real location of a Python 3.10+, or $null.
function Get-PythonInfo([string]$Exe, [string[]]$Prefix) {
    $result = Invoke-Quiet $Exe ($Prefix + @("-c", $VersionCode))
    if ($result.Code -ne 0 -or $result.Output.Count -lt 2) { return $null }
    try { $version = [version]([string]$result.Output[0]).Trim() } catch { return $null }
    if ($version -lt $MinimumVersion) { return $null }
    return @{ Exe = $Exe; Prefix = $Prefix; Version = $version; Executable = ([string]$result.Output[1]).Trim() }
}

function Find-Python {
    if ($Python) {
        $exe = $Python
        if (Test-Path -LiteralPath $Python -PathType Leaf) { $exe = (Resolve-Path -LiteralPath $Python).Path }
        elseif (-not (Get-Command -Name $Python -CommandType Application -ErrorAction SilentlyContinue)) {
            Stop-Setup "$Python was not found."
        }
        $info = Get-PythonInfo $exe @()
        if (-not $info) { Stop-Setup "$Python is not Python $MinimumVersion or newer." }
        return $info
    }
    $launcher = @(Get-Command -Name "py" -CommandType Application -ErrorAction SilentlyContinue)
    if ($launcher.Count -gt 0) {
        foreach ($version in $PreferredVersions + @("3")) {
            $info = Get-PythonInfo $launcher[0].Source @("-$version")
            if ($info) { return $info }
        }
    }
    $paths = @()
    foreach ($name in @($PreferredVersions | ForEach-Object { "python$_" }) + @("python3", "python")) {
        $paths += @(Get-Command -Name $name -CommandType Application -All -ErrorAction SilentlyContinue |
            ForEach-Object { $_.Source })
    }
    # Installs that are not on PATH: python.org per-user and all-users
    # folders, and the Python install manager.
    foreach ($version in $PreferredVersions) {
        $digits = $version.Replace(".", "")
        if ($env:LOCALAPPDATA) {
            $paths += Join-Path $env:LOCALAPPDATA "Programs\Python\Python$digits\python.exe"
            $paths += Join-Path $env:LOCALAPPDATA "Python\pythoncore-$version-64\python.exe"
        }
        if ($env:ProgramFiles) { $paths += Join-Path $env:ProgramFiles "Python$digits\python.exe" }
    }
    # Store app aliases last: without a Store Python the alias only opens the
    # Store, and a Store Python can redirect writes under AppData.
    $ordered = @($paths | Where-Object { $_ -notmatch "\\WindowsApps\\" }) +
        @($paths | Where-Object { $_ -match "\\WindowsApps\\" })
    foreach ($exe in @($ordered | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { continue }
        $info = Get-PythonInfo $exe @()
        if ($info) { return $info }
    }
    return $null
}

foreach ($file in @($DownloaderRequirements, $LidarRequirements)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Stop-Setup "Missing $file. Reinstall the add-on." }
}

if (-not $VenvPath) {
    $base = $env:LOCALAPPDATA
    if (-not $base) { $base = Join-Path $HOME "AppData\Local" }
    $VenvPath = Join-Path $base "JarvizarCityModel\downloader-venv"
}
$VenvPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($VenvPath)
$VenvPython = Join-Path $VenvPath "Scripts\python.exe"

Write-Host "Jarvizar City Model downloader setup"
Write-Host "Environment: $VenvPath"

$reuse = $false
if (Test-Path -LiteralPath $VenvPython -PathType Leaf) {
    if ((Invoke-Quiet $VenvPython @("-c", "import sys")).Code -eq 0) {
        $reuse = $true
        Write-Host "Using the existing environment."
    }
    else {
        Write-Host "The existing environment does not run; recreating it."
    }
}

if (-not $reuse) {
    $base = Find-Python
    if (-not $base) {
        Write-Host ""
        Write-Host "Python $MinimumVersion or newer was not found." -ForegroundColor Red
        Write-Host "Install Python 3.11, 3.12 or 3.13 from https://www.python.org/downloads/windows/"
        Write-Host "In the installer, tick 'Add python.exe to PATH'."
        Write-Host "Then open a new PowerShell window and run the setup command again."
        exit 1
    }
    Write-Host "Using Python $($base.Version): $($base.Executable)"
    $clear = @()
    if (Test-Path -LiteralPath $VenvPath) {
        if (Test-Path -LiteralPath (Join-Path $VenvPath "pyvenv.cfg") -PathType Leaf) {
            $clear = @("--clear")
        }
        elseif (@(Get-ChildItem -LiteralPath $VenvPath -Force).Count -gt 0) {
            Stop-Setup "$VenvPath exists and is not a Python environment. Choose an empty folder."
        }
    }
    $arguments = $base.Prefix + @("-m", "venv") + $clear + @($VenvPath)
    & $base.Exe @arguments
    if ($LASTEXITCODE -ne 0) { Stop-Setup "Could not create the environment at $VenvPath." }
    if (-not (Test-Path -LiteralPath $VenvPython -PathType Leaf)) {
        $message = "The environment was not created at $VenvPath."
        if ($base.Executable -match "\\WindowsApps\\") {
            $message += " Python from the Microsoft Store can redirect this folder; install Python from python.org and run setup again."
        }
        Stop-Setup $message
    }
}

if ($SkipInstall) {
    Write-Host "Skipping package installation (-SkipInstall)."
}
else {
    if ((Invoke-Quiet $VenvPython @("-m", "pip", "--version")).Code -ne 0) {
        & $VenvPython -m ensurepip --upgrade
        if ($LASTEXITCODE -ne 0) { Stop-Setup "pip is missing. Reinstall Python from python.org with pip included." }
    }
    Write-Host ""
    Write-Host "Updating pip..."
    & $VenvPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { Write-Host "Could not update pip; continuing with the installed version." }
    $requirements = $DownloaderRequirements
    if ($WithLidar) { $requirements = $LidarRequirements }
    Write-Host ""
    Write-Host "Installing $requirements..."
    & $VenvPython -m pip install --requirement $requirements
    if ($LASTEXITCODE -ne 0) { Stop-Setup "Package installation failed. Check the internet connection and run setup again." }

    $verify = "import importlib.metadata as m, overturemaps.core; v = m.version('overturemaps'); print('overturemaps ' + v)"
    $pin = @(Select-String -LiteralPath $DownloaderRequirements -Pattern "^\s*overturemaps\s*==\s*([^\s#;]+)")
    if ($pin.Count -gt 0) {
        $expected = $pin[0].Matches[0].Groups[1].Value
        $verify += "; assert v == '$expected', 'expected $expected, found ' + v"
    }
    & $VenvPython -c $verify
    if ($LASTEXITCODE -ne 0) { Stop-Setup "overturemaps does not import in $VenvPath." }
    if ($WithLidar) {
        & $VenvPython -c "import laspy, lazrs, pyproj, shapely, shapefile; print('LiDAR packages ready')"
        if ($LASTEXITCODE -ne 0) { Stop-Setup "The LiDAR packages do not import in $VenvPath." }
    }
}

Write-Host ""
Write-Host "Setup complete. In Blender, click Detect in Downloader Setup,"
Write-Host "or set the add-on preference Overture Python to this path:"
Write-Host $VenvPython
exit 0
