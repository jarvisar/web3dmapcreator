import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import { crsFromEpsg, crsFromWkt, lonLatTransforms, setProjector, wktEpsg } from './crs';

setProjector((from, to) => proj4(from, to));

const near = ([lon, lat]: [number, number], [lon2, lat2]: [number, number]) => {
  expect(lon).toBeCloseTo(lon2, 4);
  expect(lat).toBeCloseTo(lat2, 4);
};

describe('state plane zones in US feet', () => {
  it('places KyFromAbove and Indiana tile corners where their grids say', () => {
    // KyFromAbove N015E299 (Covington) and Indiana's in2025_28222356, lower left corners.
    near(lonLatTransforms(crsFromEpsg(3089)).toLonLat(5270000, 4285000), [-84.52156, 39.08463]);
    near(lonLatTransforms(crsFromEpsg(6473)).toLonLat(5270000, 4285000), [-84.52156, 39.08463]);
    near(lonLatTransforms(crsFromEpsg(6461)).toLonLat(2822500, 2356250), [-87.56041, 41.71601]);
    const [x, y] = lonLatTransforms(crsFromEpsg(6459)).fromLonLat(-86.48912, 40.68827);
    expect(x).toBeCloseTo(100000, -1);
    expect(y).toBeCloseTo(1982500, -1);
  });

  it("reads a compound WKT through its horizontal part when the code isn't known", () => {
    const wkt =
      'COMPD_CS["x",PROJCS["NAD83 / Kentucky Single Zone (ftUS)",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic_2SP"],PARAMETER["standard_parallel_1",37.0833333333333],PARAMETER["standard_parallel_2",38.6666666666667],PARAMETER["latitude_of_origin",36.3333333333333],PARAMETER["central_meridian",-85.75],PARAMETER["false_easting",4921250],PARAMETER["false_northing",3280833.333],UNIT["US survey foot",0.304800609601219],AXIS["X",EAST],AXIS["Y",NORTH],AUTHORITY["EPSG","99999"]],VERT_CS["NAVD88 height (ftUS)",VERT_DATUM["North American Vertical Datum 1988",2005],UNIT["US survey foot",0.304800609601219],AXIS["Up",UP]]]';
    near(lonLatTransforms(crsFromWkt(wkt)).toLonLat(5270000, 4285000), [-84.52156, 39.08463]);
  });

  it('measure distances in feet from a code alone, as their WKT does', () => {
    // Illinois East (ftUS), what Will County's 2014 tiles fall back to.
    expect(crsFromEpsg(3435).horizontalFactor).toBeCloseTo(1200 / 3937, 12);
    expect(crsFromEpsg(6565).horizontalFactor).toBeCloseTo(1200 / 3937, 12);
    for (const metres of [2154, 26971, 3088, 32633, 25832, 6339, 3857, 4326, 99999]) expect(crsFromEpsg(metres).horizontalFactor).toBe(1);
  });
});

describe('datum shifts', () => {
  const within = ([x, y]: [number, number], [x2, y2]: [number, number], metres: number) => expect(Math.hypot(x - x2, y - y2)).toBeLessThan(metres);

  it('put Dutch and Czech points where their own grids do', () => {
    // A Rotterdam building's centroid from PDOK's BAG, in WGS 84 and in RD New.
    within(lonLatTransforms(crsFromEpsg(28992)).fromLonLat(4.476028, 51.920987), [92318.7, 437337.7], 1);
    // Prague, from PROJ 9.5 with S-JTSK to WGS 84 (1).
    within(lonLatTransforms(crsFromEpsg(5514)).fromLonLat(14.42076, 50.08804), [-742835.98, -1042944.72], 1);
  });
});

describe('codes from a WKT', () => {
  it("takes the CRS's own code, not its unit's or datum's", () => {
    const lambert = 'PROJCS["RGF93 v1 / Lambert-93",GEOGCS["RGF93 v1",DATUM["Reseau_Geodesique_Francais_1993_v1",SPHEROID["GRS 1980",6378137,298.257222101,AUTHORITY["EPSG","7019"]],AUTHORITY["EPSG","6171"]],AUTHORITY["EPSG","4171"]],PROJECTION["Lambert_Conformal_Conic_2SP"],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","2154"]]';
    expect(wktEpsg(lambert)).toBe(2154);
    expect(wktEpsg('PROJCRS["ETRS89 / UTM zone 32N",BASEGEOGCRS["ETRS89",DATUM["x",ELLIPSOID["GRS 1980",6378137,298.257222101]],ID["EPSG",4258]],CONVERSION["UTM zone 32N",METHOD["Transverse Mercator",ID["EPSG",9807]]],ID["EPSG",25832]]')).toBe(25832);
    // Anchorage's ESRI WKT ends in its unit's code.
    expect(wktEpsg('PROJCS["NAD_1983_2011_StatePlane_Alaska_4_FIPS_5004_Feet",GEOGCS["GCS_NAD_1983_2011",DATUM["D_NAD_1983_2011",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["US survey foot",0.3048006096012192,AUTHORITY["EPSG","9003"]]]')).toBeNull();
  });

  it('reads a grid without a code of its own through its WKT', () => {
    // NOAA's Olympic Peninsula 2017: no code for the grid, 6783 for its geographic CRS.
    const wkt =
      'COMPD_CS["NAD83(CORS96) / UTM zone 10N + NAVD88 height",PROJCS["NAD83(CORS96) / UTM zone 10N",GEOGCS["NAD83(CORS96)",DATUM["NAD83_Continuously_Operating_Reference_Station_1996",SPHEROID["GRS 1980",6378137,298.257222101,AUTHORITY["EPSG","7019"]],AUTHORITY["EPSG","1133"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","6783"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-123],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH]],VERT_CS["NAVD88 height",VERT_DATUM["North American Vertical Datum 1988",2005,AUTHORITY["EPSG","5103"]],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Gravity-related height",UP],AUTHORITY["EPSG","5703"]]]';
    const crs = crsFromWkt(wkt);
    expect(crs.epsg).toBeNull();
    near(lonLatTransforms(crs).toLonLat(502482, 5269695), lonLatTransforms(crsFromEpsg(26910)).toLonLat(502482, 5269695));
  });
});
