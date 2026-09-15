# Build, back up, replace and verify the installed Blender 3.6 add-on in one
# quiet step. Prints a short summary only; run from the repository root.
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
"$line"
"BACKUP $backup"
"INSTALL_OK $manifest"
