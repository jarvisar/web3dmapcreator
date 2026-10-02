// WKT records as some writers leave them.

import { describe, expect, it } from 'vitest';
import { wktOf, type Vlr } from './las';

const record = (text: string): Vlr[] => [{ userId: 'LASF_Projection', recordId: 2112, data: new TextEncoder().encode(`${text}\0`) }];

describe('WKT records', () => {
  it('reads a plain WKT', () => {
    expect(wktOf(record('PROJCS["ETRS89 / UTM zone 32N",AUTHORITY["EPSG","25832"]]'))).toBe('PROJCS["ETRS89 / UTM zone 32N",AUTHORITY["EPSG","25832"]]');
  });

  it("unquotes one LAStools wrote as a JSON string (Estonia's 2024 tiles)", () => {
    expect(wktOf(record('"COMPD_CS[\\"Estonian Coordinate System of 1997 + EH2000 height\\",PROJCS[\\"Estonian Coordinate System of 1997\\"]]"'))).toBe(
      'COMPD_CS["Estonian Coordinate System of 1997 + EH2000 height",PROJCS["Estonian Coordinate System of 1997"]]',
    );
  });

  it("leaves the GeoKeys to say when the record isn't WKT (GUGiK's sheets through las2las)", () => {
    expect(wktOf(record("''"))).toBeNull();
    expect(wktOf(record(''))).toBeNull();
    expect(wktOf([])).toBeNull();
  });
});
