"""Retain complete compatible geometry only where surface inference is unresolved.

This operates on an already accepted whole-building measurement. It cannot
admit a previously rejected building or publish only its reconstructed podium.
"""
import numpy as np
from shapely import STRtree, contains_xy, force_2d, get_coordinates, points as make_points
from shapely.geometry import Polygon, shape
from shapely.ops import unary_union
from shapely.errors import GEOSException

try:
    from . import lidar_facets as facets
except ImportError:
    import lidar_facets as facets


def complete_from_retained(record,footprint,candidate):
    if not candidate.get('surfaces') or not candidate.get('unresolved'):
        return record
    try:
        from .lidar_surfaces import _planar_surfaces
    except ImportError:
        from lidar_surfaces import _planar_surfaces
    try:
        retained=[]
        if record.get('roof_surfaces'):
            for surface in record['roof_surfaces']:
                geometry=shape(surface['geometry'])
                xyz=np.asarray(geometry.exterior.coords)[:,:3]
                center=xyz[:,:2].mean(axis=0)
                design=np.column_stack((xyz[:,:2]-center,np.ones(len(xyz))))
                coef,_,rank,_=np.linalg.lstsq(design,xyz[:,2],rcond=None)
                if rank<3:
                    return record
                retained.append((Polygon(xyz[:,:2],[np.asarray(h.coords)[:,:2] for h in geometry.interiors]),center,coef))
        else:
            remaining=footprint
            for geometry,height in [(shape(t['geometry']),t['top_m']) for t in reversed(record.get('tiers',()))]+[(footprint,record['height_m'])]:
                retained.extend((p,np.zeros(2),np.array([0.,0.,height]))
                                for p in facets.pieces(remaining.intersection(geometry)))
                remaining=remaining.difference(geometry)
        tree=STRtree([g for g,_c,_p in retained])
        unresolved=list(candidate['unresolved'])
        surfaces=[]
        def heights(roofs,tree,xy):
            a,b=tree.query(make_points(xy),predicate='intersects')
            z=np.full(len(xy),-np.inf)
            for j in np.unique(b):
                ids=a[b==j]
                _g,center,coef=roofs[int(j)]
                np.maximum.at(z,ids,(xy[ids]-center)@coef[:2]+coef[2])
            return z
        if candidate.get('supported') and 'evidence' in candidate:
            evidence=candidate['evidence']
            for region,proposed in candidate['supported']:
                # Check actual XY ownership, including narrow boundary strips;
                # eroding this test can leave exactly those strips unaudited.
                selected=evidence[contains_xy(region.buffer(1e-7),evidence[:,0],evidence[:,1])]
                if len(selected)>=3:
                    roofs=[]
                    for surface in proposed:
                        geometry=shape(surface['geometry'])
                        xyz=np.asarray(geometry.exterior.coords)[:,:3]
                        center=xyz[:,:2].mean(axis=0)
                        coef=np.linalg.lstsq(np.column_stack((xyz[:,:2]-center,np.ones(len(xyz)))),xyz[:,2],rcond=None)[0]
                        roofs.append((geometry,center,coef))
                    proposed_z=heights(roofs,STRtree([r[0] for r in roofs]),selected[:,:2])
                    retained_z=heights(retained,tree,selected[:,:2])
                    new_error=np.abs(proposed_z-selected[:,2])
                    old_error=np.abs(retained_z-selected[:,2])
                    tolerance=max(.2,.025/candidate['scale'][1])
                    if (not np.all(np.isfinite(new_error))
                            or new_error.mean()>old_error.mean()+tolerance
                            or np.quantile(new_error,.95)>np.quantile(old_error,.95)+tolerance*2):
                        unresolved.append((region,'surface ownership disagrees with observed roof'))
                        continue
                surfaces.extend(proposed)
        else:
            surfaces=list(candidate['surfaces'])
        if not surfaces:
            return record
        # A local fallback must not cut a horizontal plateau into an existing
        # continuous slope or leave a thin remnant of a roof crown. Retain the
        # entire connected old surface when any of it remains unresolved.
        # Real vertical walls separate these components, so other roof levels
        # can still use the new reconstruction independently.
        parent=list(range(len(retained)))
        def root(i):
            while parent[i]!=i:
                parent[i]=parent[parent[i]];i=parent[i]
            return i
        for i,(geometry,ca,pa) in enumerate(retained):
            for j in tree.query(geometry.buffer(1e-5),predicate='intersects'):
                j=int(j)
                if j<=i or root(i)==root(j):continue
                other,cb,pb=retained[j]
                shared=geometry.boundary.intersection(other.boundary.buffer(1e-5,cap_style=2))
                if shared.length<1e-3:continue
                xy=get_coordinates(shared)[:,:2]
                gap=(xy-ca)@pa[:2]+pa[2]-((xy-cb)@pb[:2]+pb[2])
                if len(gap) and np.max(np.abs(gap))<1e-4:
                    parent[root(j)]=root(i)
        missing=unary_union([g for g,_reason in unresolved])
        affected={root(i) for i,(g,_c,_p) in enumerate(retained) if g.intersection(missing).area>1e-6}
        protected=unary_union([g for i,(g,_c,_p) in enumerate(retained) if root(i) in affected])
        if protected.area>missing.area+1e-6:
            missing=unary_union([missing,protected])
            clipped=[]
            for surface in surfaces:
                geometry=shape(surface['geometry'])
                xyz=np.asarray(geometry.exterior.coords)[:,:3]
                center=xyz[:,:2].mean(axis=0)
                coef=np.linalg.lstsq(np.column_stack((xyz[:,:2]-center,np.ones(len(xyz)))),xyz[:,2],rcond=None)[0]
                clipped.extend(_planar_surfaces(force_2d(geometry.difference(missing)),center,coef))
            surfaces=clipped
            unresolved=[(missing,'retained connected surface around unresolved patches')]
        if not surfaces:
            return record
        if sum(shape(s['geometry']).area for s in surfaces)<record['cell_m']**2*4:
            return record
        notes=[]
        for region,reason in unresolved:
            added=[]
            for i in tree.query(region,predicate='intersects'):
                geometry,center,coef=retained[int(i)]
                added.extend(_planar_surfaces(region.intersection(geometry),center,coef))
            if abs(sum(shape(s['geometry']).area for s in added)-region.area)>max(.002,region.area*.001):
                return record
            surfaces.extend(added)
            notes.append({'reason':reason,'area_m2':float(region.area)})
        if len(surfaces)>facets.MAX_FACETS or any(
                sum(len(r) for r in s['geometry']['coordinates'])>4096 for s in surfaces):
            return record
        shapes=[shape(s['geometry']) for s in surfaces]
        allowance=max(.002,footprint.area*.001)
        if (abs(sum(g.area for g in shapes)-footprint.area)>allowance
                or unary_union(shapes).symmetric_difference(footprint).area>allowance):
            return record
        z=[v[2] for s in surfaces for ring in s['geometry']['coordinates'] for v in ring]
        low=min(z)
        if low<=2:
            return record
        surfaces=[{**s,'bottom_m':float(low)} for s in surfaces]
        fraction=sum(n['area_m2'] for n in notes)/footprint.area
        return {**record,**candidate['metadata'],'height_m':float(low),'method':'faceted_roof',
                'tiers':[],'roof_surfaces':surfaces,
                'surface_reconstruction':'coherent_regions_with_retained_patches',
                'retained_surface_patches':notes,'retained_surface_area_fraction':float(fraction)}
    except (GEOSException,ValueError,np.linalg.LinAlgError):
        return record
