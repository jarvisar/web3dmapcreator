# web3dmapcreator Development Principles

Read [CLAUDE.md](CLAUDE.md) for shared architecture, workflows, and regression
guidance. Despite its filename, it is the project context for all coding agents.
Treat the current implementation, configuration, and tests as the source of truth.

- Diagnose the general underlying cause.
- Never special-case cities, buildings, or coordinates.
- Preserve existing behavior that already works.
- This project is primarily intended for FDM 3D printing. SVG maps for laser
  engraving, pen plotters and print are the second output. Keep changes to one
  from breaking the other.
- Use the default output scale (0.07 mm per metre) as the reference for printability.
- Everything runs in the browser: no server, and every data source must allow CORS.
- Keep `src/core` free of DOM and React code so it runs in the worker and in Node.
- Test known regression areas when modifying related systems.
- Never list Claude or any AI tool as an author or co-author: no `Co-Authored-By` trailers, "Generated with" lines or session links in commits or pull requests, and no AI names in author, maintainer or copyright fields. The owner commits and pushes. `.claude/settings.json` turns Claude Code's attribution off, and `.githooks/commit-msg` (enabled with `git config core.hooksPath .githooks`) strips such lines and refuses AI identities.

For verification, follow [.claude/commands/verify.md](.claude/commands/verify.md).
Keep shared context in `CLAUDE.md` rather than duplicating architecture here.
