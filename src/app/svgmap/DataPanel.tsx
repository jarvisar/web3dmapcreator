import { fieldRange } from '../../core/svgmap/limits';
import { DEFAULT_SOURCE } from '../../core/svgmap/settings';
import { TextField } from '../components/Fields';
import { NumberField } from '../components/NumberField';
import { Section } from '../panels/Section';
import { patchSvg, useApp } from '../state/store';

export function DataPanel() {
  const source = useApp((state) => state.svg.source);
  const custom = source.tiles !== DEFAULT_SOURCE.tiles;
  return (
    <Section id="data" title="Map data" summary={custom ? 'Custom source' : 'OpenFreeMap'}>
      <TextField
        label="Tile source"
        value={source.tiles}
        commitOnBlur
        onChange={(tiles) => patchSvg({ source: { ...source, tiles: tiles.trim() || DEFAULT_SOURCE.tiles } })}
        help="A TileJSON URL, a {z}/{x}/{y} template or a .pmtiles file. It has to use the OpenMapTiles schema. SVG maps are drawn from these vector tiles, not the Overture data the 3D models use."
      />
      {custom && (
        <button type="button" className="btn btn-sm align-start" onClick={() => patchSvg({ source: { ...source, tiles: DEFAULT_SOURCE.tiles } })}>
          Use OpenFreeMap
        </button>
      )}
      <NumberField
        label="Most tiles per map"
        value={source.maxTiles}
        onChange={(maxTiles) => patchSvg({ source: { ...source, maxTiles: Math.round(maxTiles) } })}
        {...fieldRange('source.maxTiles')}
        step={10}
        decimals={0}
        help="Bigger areas switch to less detailed tiles to stay under this. A city centre at 1:20,000 needs 4 to 12."
      />
    </Section>
  );
}
