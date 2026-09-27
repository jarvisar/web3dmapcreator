# Build, back up, replace and verify the installed Blender 3.6 add-on, and the
# extension in the newest Blender 4.2+ found, in one quiet step. Prints a short
# summary only; run from the repository root.
# Blender may stay open: Python source files are not locked on Windows, and a
# running session keeps using its already imported copy until restarted.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$blender = "C:\Program Files\Blender Foundation\Blender 3.6\blender.exe"
$addons = Join-Path $env:APPDATA "Blender Foundation\Blender\3.6\scripts\addons"
$target = Join-Path $addons "jarvizar_city_model"
$userpref = Join-Path $env:APPDATA "Blender Foundation\Blender\3.6\config\userpref.blend"

$manifest = (Select-String -Path (Join-Path $repo "jarvizar_city_model\blender_manifest.toml") -Pattern '^version = "([^"]+)"').Matches[0].Groups[1].Value
$tuple = (Select-String -Path (Join-Path $repo "jarvizar_city_model\__init__.py") -Pattern '"version": \((\d+), (\d+), (\d+)\)').Matches[0]
$initVersion = "$($tuple.Groups[1].Value).$($tuple.Groups[2].Value).$($tuple.Groups[3].Value)"
if ($manifest -ne $initVersion) { throw "Version mismatch: manifest $manifest, bl_info $initVersion" }

& python (Join-Path $repo "scripts\build_addon.py") | Out-Null
$archive = Join-Path $repo "dist\jarvizar_city_model-$manifest-blender36.zip"
if (-not (Test-Path -LiteralPath $archive)) { throw "Archive not built: $archive" }

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $repo "dist\addon-backup-$stamp"
New-Item -ItemType Directory -Path $backup | Out-Null
if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination $backup -Recurse }
if (Test-Path -LiteralPath $userpref) { Copy-Item -LiteralPath $userpref -Destination $backup }

if ($target -ne (Join-Path $addons "jarvizar_city_model")) { throw "Refusing to remove $target" }
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
Expand-Archive -LiteralPath $archive -DestinationPath $addons -Force

$verify = Join-Path $env:TEMP "jcm_verify_install.py"
@'
import bpy, jarvizar_city_model as addon
bpy.ops.preferences.addon_enable(module="jarvizar_city_model")
prefs = bpy.context.preferences.addons["jarvizar_city_model"].preferences
print("INSTALLED", addon.__file__, ".".join(map(str, addon.bl_info["version"])), "downloader:", prefs.overture_python_path or "unset")
bpy.ops.wm.save_userpref()
'@ | Set-Content -Path $verify -Encoding UTF8
$output = & $blender --background --python-exit-code 1 --python $verify 2>&1
$line = $output | Select-String -Pattern "^INSTALLED " | Select-Object -First 1
if ($LASTEXITCODE -ne 0 -or -not $line) { $output | Select-Object -Last 15; throw "Verification failed; rollback copy in $backup" }
$installed = @("$line")
$versions = @("3.6")

# The newest installed Blender 4.2+ also gets the extension build, in its
# user_default repository (package bl_ext.user_default.jarvizar_city_model).
$latest = Get-ChildItem -Directory "C:\Program Files\Blender Foundation" |
    Where-Object { $_.Name -match '^Blender \d+\.\d+$' -and [version]($_.Name -replace '^Blender ', '') -ge [version]"4.2" } |
    Sort-Object { [version]($_.Name -replace '^Blender ', '') } -Descending | Select-Object -First 1
if ($latest) {
    $version = $latest.Name -replace '^Blender ', ''
    $blenderLatest = Join-Path $latest.FullName "blender.exe"
    $extension = Join-Path $repo "dist\jarvizar_city_model-$manifest-extension.zip"
    if (-not (Test-Path -LiteralPath $extension)) { throw "Archive not built: $extension" }
    $userLatest = Join-Path $env:APPDATA "Blender Foundation\Blender\$version"
    $extensionTarget = Join-Path $userLatest "extensions\user_default\jarvizar_city_model"
    $latestBackup = Join-Path $backup "blender-$version"
    New-Item -ItemType Directory -Path $latestBackup | Out-Null
    if (Test-Path -LiteralPath $extensionTarget) { Copy-Item -LiteralPath $extensionTarget -Destination $latestBackup -Recurse }
    $latestPref = Join-Path $userLatest "config\userpref.blend"
    if (Test-Path -LiteralPath $latestPref) { Copy-Item -LiteralPath $latestPref -Destination $latestBackup }

    $output = & $blenderLatest --command extension install-file -r user_default -e $extension 2>&1
    if ($LASTEXITCODE -ne 0) { $output | Select-Object -Last 15; throw "Blender $version install failed; rollback copy in $latestBackup" }

    # A new Blender version starts without the downloader preference; carry
    # over the one Blender 3.6 uses, never replacing one already set.
    $downloader = "$line" -replace '^.* downloader: ', ''
    $env:JCM_DOWNLOADER = if ($downloader -ne "unset") { $downloader } else { "" }
    $verifyLatest = Join-Path $env:TEMP "jcm_verify_extension.py"
    @'
import os, sys, tomllib, bpy, addon_utils
from pathlib import Path
name = "bl_ext.user_default.jarvizar_city_model"
addon_utils.enable(name, default_set=True, handle_error=None)
prefs = bpy.context.preferences.addons[name].preferences
if not prefs.overture_python_path and os.environ.get("JCM_DOWNLOADER"):
    prefs.overture_python_path = os.environ["JCM_DOWNLOADER"]
addon = sys.modules[name]
# Extensions drop bl_info; their version is the installed manifest's.
version = tomllib.loads(Path(addon.__file__).with_name("blender_manifest.toml").read_text(encoding="utf-8"))["version"]
print("INSTALLED", addon.__file__, version, "downloader:", prefs.overture_python_path or "unset")
bpy.ops.wm.save_userpref()
'@ | Set-Content -Path $verifyLatest -Encoding UTF8
    $output = & $blenderLatest --background --python-exit-code 1 --python $verifyLatest 2>&1
    $line = $output | Select-String -Pattern "^INSTALLED " | Select-Object -First 1
    if ($LASTEXITCODE -ne 0 -or -not $line) { $output | Select-Object -Last 15; throw "Blender $version verification failed; rollback copy in $latestBackup" }
    $installed += "$line"
    $versions += $version
}
$installed
"BACKUP $backup"
"INSTALL_OK $manifest Blender $($versions -join ', ')"
