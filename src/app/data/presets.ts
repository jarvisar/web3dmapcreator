// Area presets carried over from the add-on's data/bounds_presets.txt, with
// the same names, plus the example cities of SVGmap. Bounds are west, south,
// east, north.

import { parseBoundsText } from '../../core/geo/area';
import type { GeoBounds } from '../../core/types';

export interface AreaPreset {
  name: string;
  bounds: GeoBounds;
  /** Title for an SVG map, like CHICAGO. */
  title: string;
}

export interface PresetGroup {
  label: string;
  note?: string;
  presets: AreaPreset[];
}

// SVGmap's cities come last. Their bounds are its frames on a 5 x 7 in plaque.
const CITIES = `
Chicago - The Loop: -87.64575,41.87052,-87.60627,41.89397
Chicago - The Loop (small): -87.64124,41.87626,-87.61552,41.89041
Salt Lake City - Downtown: -111.90957,40.75561,-111.87889,40.78022
Clearwater - Beach and Downtown: -82.83485,27.96044,-82.79572,27.98152
Rome - Historic Centre: 12.45845,41.88803,12.49510,41.90649
San Francisco (large): -122.44417,37.76678,-122.37834,37.81745
Milwaukee - Downtown: -87.92650,43.02416,-87.88925,43.04706
Walt Disney World - Magic Kingdom: -81.60576,28.39744,-81.55542,28.42994
New York City - Lower Manhattan: -74.02000,40.69800,-73.98200,40.72000
Disneyland - Anaheim: -117.93851,33.79914,-117.90109,33.82053
Las Vegas - The Strip: -115.20238,36.07963,-115.14393,36.13378
Boston - Downtown: -71.08785,42.34434,-71.03974,42.37512
Miami - Downtown and Brickell: -80.21513,25.74555,-80.16191,25.79804
Albuquerque - Downtown and Old Town: -106.68068,35.05846,-106.61716,35.10966
Paris (large): 2.26078,48.83275,2.37013,48.88741
Cincinnati - Downtown: -84.53100,39.08788,-84.49392,39.10758
Vancouver - Downtown: -123.15573,49.26945,-123.09663,49.29583
New York City - Midtown: -74.01848,40.73204,-73.94152,40.77196
Paris - Centre: 2.31233,48.84127,2.38047,48.87193
London - Centre: -0.14601,51.49267,-0.07399,51.52333
Amsterdam - Centre: 4.86951,52.35947,4.92089,52.38093
Venice: 12.31023,45.42636,12.35497,45.44784
Sydney - Centre: 151.18769,-33.87330,151.23091,-33.84870
`;

const LANDMARKS = `
Paris - Eiffel Tower: 2.27504,48.84555,2.31396,48.87125
London - Westminster: -0.14517,51.48786,-0.10403,51.51354
Rome - Colosseum: 12.47499,41.87734,12.50941,41.90306
Sydney - Opera House: 151.19986,-33.86968,151.23074,-33.84392
Tokyo - Tokyo Tower: 139.72963,35.64573,139.76117,35.67147
Berlin - Brandenburg Gate: 13.35666,52.50346,13.39874,52.52914
Barcelona - Sagrada Familia: 2.15732,41.39074,2.19148,41.41646
Seattle - Space Needle: -122.3683,47.60765,-122.3303,47.63335
San Francisco - Golden Gate Bridge: -122.49452,37.80703,-122.46208,37.83277
Dubai - Burj Khalifa: 55.26023,25.1843,55.28857,25.2101
`;

// SVGmap's titles where they aren't just the city.
const TITLES: Record<string, string> = { 'New York City': 'NEW YORK', Venice: 'VENEZIA' };

function parse(block: string): AreaPreset[] {
  return block
    .trim()
    .split('\n')
    .map((line) => {
      const split = line.lastIndexOf(':');
      const name = line.slice(0, split).trim();
      const city = name.split(' - ')[0].replace(/\s*\(.*\)$/, '');
      return { name, bounds: parseBoundsText(line.slice(split + 1)), title: TITLES[city] ?? city.toUpperCase() };
    });
}

export const PRESET_GROUPS: PresetGroup[] = [
  { label: 'Cities', presets: parse(CITIES) },
  { label: 'Landmarks', note: '200 × 200 mm at the default scale', presets: parse(LANDMARKS) },
];
