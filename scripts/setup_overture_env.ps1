[CmdletBinding()]
param(
    [Parameter()]
    [string]$Python = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$RequirementsPath = Join-Path $ProjectRoot "requirements-downloader.txt"
$VenvPath = Join-Path $ProjectRoot ".venv-overture"
$VenvPython = Join-Path $VenvPath "Scripts\python.exe"

if (-not (Test-Path -LiteralPath $RequirementsPath -PathType Leaf)) {
    throw "Requirements file not found: $RequirementsPath"
}

$BasePython = $null
$BaseArguments = @()

if ($Python) {
    if (Test-Path -LiteralPath $Python -PathType Leaf) {
        $BasePython = (Resolve-Path -LiteralPath $Python).Path
    }
    else {
        $Command = Get-Command -Name $Python -CommandType Application -ErrorAction Stop
        $BasePython = $Command.Source
    }
}
else {
    $PyLauncher = Get-Command -Name "py" -CommandType Application -ErrorAction SilentlyContinue
    if ($PyLauncher) {
        & $PyLauncher.Source -3.11 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" *> $null
        if ($LASTEXITCODE -eq 0) {
            $BasePython = $PyLauncher.Source
            $BaseArguments = @("-3.11")
        }
    }

    if (-not $BasePython) {
        foreach ($CandidateName in @("python3.11", "python")) {
            $Candidate = Get-Command -Name $CandidateName -CommandType Application -ErrorAction SilentlyContinue
            if (-not $Candidate) {
                continue
            }
            & $Candidate.Source -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" *> $null
            if ($LASTEXITCODE -eq 0) {
                $BasePython = $Candidate.Source
                break
            }
        }
    }
}

if (-not $BasePython) {
    throw "Python 3.10 or newer was not found. Install Python 3.11 or pass -Python with an interpreter path."
}

& $BasePython @BaseArguments -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
if ($LASTEXITCODE -ne 0) {
    throw "The selected interpreter must be Python 3.10 or newer: $BasePython"
}

if (-not (Test-Path -LiteralPath $VenvPython -PathType Leaf)) {
    Write-Host "Creating downloader environment at $VenvPath"
    & $BasePython @BaseArguments -m venv $VenvPath
    if ($LASTEXITCODE -ne 0) {
        throw "Could not create the virtual environment."
    }
}
else {
    Write-Host "Reusing downloader environment at $VenvPath"
}

& $VenvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) {
    throw "Could not upgrade pip in $VenvPath"
}

& $VenvPython -m pip install --requirement $RequirementsPath
if ($LASTEXITCODE -ne 0) {
    throw "Could not install $RequirementsPath"
}

& $VenvPython -c "import importlib.metadata as metadata; version = metadata.version('overturemaps'); assert version == '1.0.2', version; print('overturemaps ' + version + ' is ready')"
if ($LASTEXITCODE -ne 0) {
    throw "The installed Overture client did not pass verification."
}

Write-Host "Set Blender's 'Overture Python' field to:"
Write-Host $VenvPython

