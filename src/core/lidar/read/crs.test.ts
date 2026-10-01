import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import { crsFromEpsg, crsFromWkt, lonLatTransforms, setProjector } from './crs';

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
});
