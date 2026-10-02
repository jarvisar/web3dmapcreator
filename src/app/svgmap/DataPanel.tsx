import { fieldRange } from '../../core/svgmap/limits';
import { DEFAULT_SOURCE } from '../../core/svgmap/settings';
import { CheckField, TextField } from '../components/Fields';
import { NumberField } from '../components/NumberField';
import { Section } from '../panels/Section';
import { patchSvg, useApp } from '../state/store';

export function DataPanel() {
  const source = useApp((state) => state.svg.source);
  const buildingsShown = useApp((state) => state.svg.layers.buildings);
  const custom = source.tiles !== DEFAULT_SOURCE.tiles;
  const summary = `${custom ? 'Custom source' : 'OpenFreeMap'}${source.overtureBuildings ? ' + Overture' : ''}`;
  return (
    <Section id="data" title="Map data" summary={summary}>
      <TextField
        label="Tile source"
        value={source.tiles}
        commitOnBlur
        onChange={(tiles) => patchSvg({ source: { ...source, tiles: tiles.trim() || DEFAULT_SOURCE.tiles } })}
        help="A TileJSON URL, a {z}/{x}/{y} template or a .pmtiles file. It has to use the OpenMapTiles schema. SVG maps are drawn from these vector tiles, not the Overture data the 3D models use, apart from the buildings option below."
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
      <CheckField
        label="Add missing buildings from Overture"
        checked={source.overtureBuildings}
        disabled={!buildingsShown}
        onChange={(overtureBuildings) => patchSvg({ source: { ...source, overtureBuildings } })}
        help="Adds the building outlines Overture Maps has and OpenStreetMap doesn't, mostly Microsoft's and Google's machine-learning footprints. It fills in suburbs and towns nobody has mapped yet, and adds little in big city centres. It's a second download, so maps take longer, and it only works at full detail (zoom 14). Needs the Buildings layer."
      />
    </Section>
  );
}
