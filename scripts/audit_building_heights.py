"""Compare current source roof interpretation to the pre-0.10 blanket rule.

python scripts/audit_building_heights.py --cache <bbox-directory> --output audit.json
Reads source data only; never changes the cache or Blender scene.
"""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jarvizar_city_model.data.geojson import load_feature_collection, feature_id, first_osm_id, geometry_polygons
from jarvizar_city_model.data.projection import create_fixed_scale_transform
from jarvizar_city_model.geometry.buildings import resolve_vertical_profile, select_building_geometry
from jarvizar_city_model.geometry.planar import effective_width
from jarvizar_city_model.geometry.roofs import resolve_roof


def audit(folder):
    buildings=load_feature_collection(folder/"building.geojson")
    parts=load_feature_collection(folder/"building_part.geojson")
    manifest=json.loads((folder/"manifest.json").read_text(encoding="utf-8"))
    transform=create_fixed_scale_transform(*manifest["bbox"],.07)
    parents={feature_id(f):f for f in buildings}
    selected=select_building_geometry(buildings,parts)
    changed,invalid=[],[]
    for feature in selected.parts:
        prop=feature["properties"]
        profile=resolve_vertical_profile(prop,3,10)
        if profile.thickness_m<=0:
            invalid.append(feature_id(feature))
            continue
        parent=parents.get(prop.get("building_id"),{}).get("properties",{})
        parent_height=parent.get("height")
        for poly in geometry_polygons(feature["geometry"]):
            ring=[transform.forward(*p[:2])[:2] for p in poly[0]]
            width=effective_width(ring)/.07
            roof=resolve_roof(prop,profile,True,parent_height,width)
            if not roof.is_shaped:
                continue
            roof_height=prop.get("roof_height")
            if not isinstance(roof_height,(int,float)) or roof_height<=0:
                roof_height=max(.5*width,.5) if roof.kind in ("pyramid","dome") else max(min(3,.6*width),.5)
            legacy=profile.top_m+roof_height
            if parent_height and parent_height>profile.top_m and legacy>parent_height+.5:
                legacy=parent_height
            if abs(legacy-roof.roof_top_m)>.001:
                changed.append({"id":feature_id(feature),"osm_id":first_osm_id(prop),
                    "height_m":prop.get("height"),"min_height_m":profile.bottom_m,
                    "roof_height_m":prop.get("roof_height"),"parent_height_m":parent_height,
                    "old_roof_top_m":legacy,"new_roof_top_m":roof.roof_top_m,
                    "difference_m":roof.roof_top_m-legacy})
    changed.sort(key=lambda row:row["difference_m"])
    return {"bbox":manifest["bbox"],"selected_buildings":len(selected.buildings),
            "selected_parts":len(selected.parts),"duplicate_outlines":len(selected.duplicate_ids),
            "changed_part_roofs":len(changed),"invalid_parts":invalid,"changes":changed,
            "note":"Source roof extents before miniature width/roof-height gates; no source heights are capped."}


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args()
    result=audit(args.cache)
    args.output.write_text(json.dumps(result,indent=2),encoding="utf-8")
    print(json.dumps({key:value for key,value in result.items() if key!="changes"}))
