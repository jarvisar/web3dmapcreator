# 3dmapcreator Development Principles

Read [CLAUDE.md](CLAUDE.md) for shared architecture, workflows, and regression
guidance. Despite its filename, it is the project context for all coding agents.
Treat the current implementation, configuration, and tests as the source of truth.

- Diagnose the general underlying cause.
- Never special-case cities, buildings, or coordinates.
- Preserve existing behavior that already works.
- This project is primarily intended for FDM 3D printing.
- Use the addon's default output scale as the reference for printability.
- Test known regression areas when modifying related systems.
- After all changes are complete and all tests pass, install the updated add-on by running `scripts/install_addon.ps1` and reporting only its summary lines (it installs into Blender 3.6 and the newest Blender 4.2+). Blender may stay open.

For add-on installation, follow [.claude/commands/install-addon.md](.claude/commands/install-addon.md).
Changes only to documentation outside the packaged add-on do not require
reinstalling identical application files. Keep shared context in `CLAUDE.md`
rather than duplicating architecture or release history here.
