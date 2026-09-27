---
description: Build, install, and verify the Blender add-on in one quiet script
---

Run after packaged add-on changes pass their tests. Documentation-only edits
outside `jarvizar_city_model/` need no reinstall. Blender does not need to be
closed; a running session picks up the new code after it restarts.

Do exactly this, nothing more:

```powershell
& .\scripts\install_addon.ps1
```

The script installs into **both** Blender versions:

- **Blender 3.6** (classic add-on): it checks that `bl_info` and
  `blender_manifest.toml` agree, builds both archives, backs up the installed
  package and `userpref.blend` to `dist/addon-backup-<timestamp>/`, replaces
  only the installed `jarvizar_city_model` directory, then enables and
  verifies the package in a fresh background Blender with existing
  preferences and saves them.
- **The newest Blender 4.2+** under `C:\Program Files\Blender Foundation`
  (currently 5.2, as an extension): it backs up
  `extensions\user_default\jarvizar_city_model` and that version's
  `userpref.blend` to `dist/addon-backup-<timestamp>/blender-<version>/`,
  installs the extension archive with `blender --command extension
  install-file -r user_default -e`, then enables and verifies
  `bl_ext.user_default.jarvizar_city_model` in a fresh background Blender.
  An unset downloader preference there is filled from Blender 3.6's; a set
  one is never replaced. If no 4.2+ Blender is installed, this part is skipped.

It prints one `INSTALLED <path> <version> downloader: <path>` line per Blender,
then `BACKUP <dir>` and `INSTALL_OK <version> Blender 3.6, <version>`.

Report those lines. Do not list installed files, diff trees, open extra
Blender sessions, or re-run the repository tests as part of installation. If
the script throws, report its last lines and the backup location; restoring
the backup directory (the `blender-<version>` subfolder for the extension) is
the rollback.

Launch Blender 4.2+ from PowerShell, not Git Bash: under Git Bash, Blender 5.2
fails to load `sycl8.dll`.
