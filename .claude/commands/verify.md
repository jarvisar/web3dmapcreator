---
description: Run the full verification stack (unit, smoke, live) and report the real numbers
---

Run all three test layers and report honestly. Do not summarise as "passing"
without the counts — the numbers are the point.

1. Unit tests (200, pure, no bpy):
   `python -m unittest discover -s tests -p "test_*.py" -t tests`

2. Synthetic full pipeline inside Blender (writes its own fixtures):
   `"/c/Program Files/Blender Foundation/Blender 3.6/blender.exe" --background --factory-startup --python tests/blender_smoke.py`

3. Real-data end-to-end plus a manifold check over every generated mesh:
   `"/c/Program Files/Blender Foundation/Blender 3.6/blender.exe" --background --factory-startup --python tests/blender_live_full.py -- --cache "C:/Users/adamj/AppData/Roaming/Blender Foundation/Blender/3.6/datafiles/jarvizar_city_model/cache"`

Report: test count, `JARVIZAR_BLENDER_SMOKE_OK` / `JARVIZAR_LIVE_FULL_OK`,
object and polygon totals, generation time, and the non-manifold count
(expected: 0 of ~10,898). If anything fails, paste the actual output rather
than describing it.

Reference figures for the sample Cincinnati bbox, so a regression is obvious:
14,199 objects, ~917k polygons, ~10 s, 0 non-manifold, 360.2 x 197.4 mm,
`water_cut_bodies: 3`, `terrain_water_cut_percent: 16.1`.
