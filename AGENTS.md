# 3dmapcreator Development Principles


- Diagnose the general underlying cause.
- Never special-case cities, buildings, or coordinates.
- Prefer targeted changes over pipeline rewrites.
- Preserve existing behavior that already works.
- This project is primarily intended for FDM 3D printing.
- Avoid obvious unsupported overhangs.
- Preserve meaningful geometry while filtering noise and tiny/unprintable detail.
- Use the addon's default output scale as the reference for printability.
- Test known regression areas when modifying related systems.
- After all changes are complete and all tests pass, install the updated add-on into Blender so the installed version reflects the latest code.