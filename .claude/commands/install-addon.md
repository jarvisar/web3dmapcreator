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

The script checks that `bl_info` and `blender_manifest.toml` agree, builds
both archives, backs up the installed package and `userpref.blend` to
`dist/addon-backup-<timestamp>/`, replaces only the installed
`jarvizar_city_model` directory, then enables and verifies the package in a
fresh background Blender with existing preferences and saves them. It prints
three lines: `INSTALLED <path> <version> downloader: <path>`, `BACKUP <dir>`,
`INSTALL_OK <version>`.

Report those three lines. Do not list installed files, diff trees, open extra
Blender sessions, or re-run the repository tests as part of installation. If
the script throws, report its last lines and the backup location; restoring
the backup directory is the rollback.
