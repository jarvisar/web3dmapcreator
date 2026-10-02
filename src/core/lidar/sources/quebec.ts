// Quebec's MRNF lidar (Données lidar du Québec): plain LAZ of 1 km MTM
// tiles, found through its WFS, newest and older surveys in two layers. Both
// the WFS and the files go through the proxy: the WFS refuses any request
// with an Origin header. What it adds over NRCan is mostly where NRCan has
// nothing, Trois-Rivières 2021 and Rimouski 2024 at about 22 returns per m².
//
// NRCan republishes some MRNF surveys whole as COPC, under the same tile
// names, and those are far cheaper to read, so they're left out here. Others
// it has only in part (river corridors) and those stay.

import { proxyAvailable } from '../../data/corsProxy';
import type { Polygon } from '../../types';
import { geoPolygons, overlaps, pagedFeatures, ringBox, type Box, type Candidate, type Provider } from './common';

const WFS = 'https://servicesvecto3.mern.gouv.qc.ca/geoserver/Index_Telechargement_Lidar_Pub/wfs';
const FILES = 'https://diffusion.mern.gouv.qc.ca/diffusion/RGQ/Lidar/';
const LAYERS = ['IndexTelechargementLidarPlusRecent', 'IndexTelechargementLidarHistorique'];
// Surveys NRCan has every tile of, by name (QC/600023_52_CMM_2023 and _2024,
// the FHIMP_PICAI projects and so on), checked against its bucket in October 2026.
const ON_NRCAN = new Set([
  '2021_RiviereGatineauLievre_LiDAR',
  '2021_RiviereSaintMaurice_LiDAR',
  '2021_RiviereYamaskaChateauguay_LiDAR',
  '2023_BasseCoteNord_LiDAR',
  '2023_CMM_LiDAR',
  '2023_MELCCFP_PICAI_LiDAR',
  '2023_MELCCFP_PICAI_2_LiDAR',
  '2024_Estrie_LiDAR',
  '2024_Outaouais_LiDAR',
]);
// 8 is ground too: model key points, at the same heights as 2 in Trois-Rivières.
const CLASSES = { '1': 'unclassified', '2': 'ground', '3': 'low vegetation', '4': 'medium vegetation', '5': 'high vegetation', '6': 'building', '8': 'ground', '9': 'water', '17': 'bridge' };

interface Found {
  url: string;
  project: string;
  epsg: number;
  dates: string[];
  coverage: Polygon[];
  box: Box;
}

/** "2021_MauriciePortneuf_LiDAR" as "2021 Mauricie Portneuf". */
export function projectName(project: string): string {
  return project
    .replace(/_lidar$/i, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

export const quebec: Provider = {
  id: 'quebec',
  name: 'MRNF Québec',
  areas: [[-79.8, 44.9, -57, 62.6]],
  async discover(fetcher, bbox) {
    if (!proxyAvailable()) return [];
    // WFS 2 takes latitude first in this CRS.
    const box = `${bbox.south},${bbox.west},${bbox.north},${bbox.east},urn:ogc:def:crs:EPSG::4326`;
    const layers = await Promise.all(
      LAYERS.map((layer) =>
        pagedFeatures(
          fetcher,
          (offset, count) =>
            `${WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=Index_Telechargement_Lidar_Pub:${layer}&outputFormat=application/json&srsName=EPSG:4326&bbox=${box}&sortBy=NOM_TUILE&count=${count}&startIndex=${offset}`,
        ),
      ),
    );
    const seen = new Set<string>();
    const groups = new Map<string, Found[]>();
    for (const row of layers.flat()) {
      const p = row.properties;
      const url = String(p.TELECHARGEMENT_TUILE ?? '');
      const project = String(p.PROJET ?? '').trim();
      // Ground only ("Données au sol") is no use for buildings or a surface.
      if (!url.startsWith(FILES) || !/\.laz$/i.test(url) || /au sol/i.test(String(p.TYPE_DONNEE ?? '')) || !project || ON_NRCAN.has(project) || seen.has(url)) continue;
      seen.add(url);
      const coverage = geoPolygons(row.geometry);
      if (!coverage.length) continue;
      const tileBox = ringBox(coverage.flat());
      if (!overlaps(tileBox, bbox)) continue;
      const dates = String(p.DATE_ACQUISITION ?? '').match(/\d{4}-\d{2}-\d{2}/g) ?? [];
      groups.set(project, [...(groups.get(project) ?? []), { url, project, epsg: Number(p.CODE_EPSG), dates, coverage, box: tileBox }]);
    }
    return [...groups].map(([project, tiles]): Candidate => {
      const dates = tiles.flatMap((t) => t.dates).sort();
      const year = Number(/^(\d{4})_/.exec(project)?.[1]) || (dates[0] ? Number(dates[0].slice(0, 4)) : null);
      return {
        provider: 'MRNF',
        id: project,
        name: `Québec ${projectName(project)}`,
        url: `${FILES}#${encodeURIComponent(project)}`,
        format: 'LAZ',
        coverage: tiles.flatMap((t) => t.coverage),
        tiles: tiles.map((t) => ({ url: t.url, bbox: t.box, horizontalCrs: Number.isInteger(t.epsg) && t.epsg > 0 ? `EPSG:${t.epsg}` : undefined })),
        verticalUnits: 'm',
        classification: CLASSES,
        acquisitionStart: dates[0] ?? (year ? `${year}-01-01` : undefined),
        acquisitionEnd: dates.at(-1) ?? (year ? `${year}-12-31` : undefined),
        license: 'CC BY 4.0',
        attribution: '© Gouvernement du Québec',
        sourcePage: 'https://www.donneesquebec.ca/recherche/dataset/donnees-lidar-du-quebec',
        authoritative: true,
        projectYearHint: year,
      };
    });
  },
};
