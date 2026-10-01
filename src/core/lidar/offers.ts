// Surveys that only come as whole files (plain LAZ and LAS, ZIPs, files read
// in one go) aren't read until the user says so, as in the add-on: a tile is
// often hundreds of MB and some servers send 80 KB/s. EPT and COPC are read
// by range as before. A staged survey that would have been used is offered
// with the tiles this area needs, and only tiles the user approved are read.
// Checkpoints of what was read before are used either way, since they cost
// nothing to download.

import { HttpError, NetworkError } from '../data/http';
import { projectYear } from './selection';
import type { Fetcher } from './read/fetcher';
import { checkTile } from './read/tiles';
import type { Candidate, Failure, Tile } from './sources';

export interface LidarOffer {
  /** The survey's key (Candidate.url). */
  url: string;
  provider: string;
  name: string;
  year: number | null;
  attribution: string;
  sourcePage: string;
  license?: string;
  /** Tiles this area needs that haven't been approved, by tileKey. */
  tiles: string[];
  /** What they come to, for those whose size is known. */
  bytes: number;
  /** Tiles whose size is unknown. */
  unsized: number;
  /** Buildings it would measure. Absent for a LiDAR only model. */
  buildings?: number;
  /** Why it's offered: the user picked it, it covers what nothing else here does, or it's much newer or denser than what was read. */
  reason: 'chosen' | 'gap' | 'newer' | 'denser';
}

/** Tile keys the user approved, or 'all' (the CLI's --download-tiles). */
export type Approval = ReadonlySet<string> | 'all';

export const staged = (survey: Candidate): boolean => survey.format === 'LAZ';

export const tileKey = (tile: Tile): string => (tile.member ? `${tile.url}#${tile.member}` : tile.url);

export function approves(approved: Approval | undefined, tiles: Tile[]): boolean {
  return approved === 'all' || (approved !== undefined && tiles.every((t) => approved.has(tileKey(t))));
}

/** A survey's tiles that reach into a lon/lat box. */
export function tilesIn(survey: Candidate, [w, s, e, n]: [number, number, number, number]): Tile[] {
  return (survey.tiles ?? []).filter((t) => t.bbox[0] <= e && t.bbox[2] >= w && t.bbox[1] <= n && t.bbox[3] >= s);
}

/** True when an earlier result offered a tile that has since been approved, so it can't stand. */
export function reopened(offers: LidarOffer[] | undefined, approved: Approval | undefined): boolean {
  if (!offers?.length || !approved) return false;
  return approved === 'all' || offers.some((o) => o.tiles.some((key) => approved.has(key)));
}

function year(date: string | undefined): number | null {
  return date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null;
}

export function surveyYear(c: Candidate): number | null {
  return year(c.acquisitionEnd) ?? year(c.acquisitionStart) ?? c.projectYearHint ?? projectYear(c.name);
}

// The add-on's thresholds for paying for a download when a streamed survey
// already measured the building: five years newer, or twice as dense and two
// more returns per m². Anything less and what was read stands.
const NEWER_YEARS = 5;
const DENSITY_RATIO = 2;
const DENSITY_GAIN = 2;

/**
 * Why `candidate` would be worth downloading where `current` was read, if it
 * would. `density` gives returns per m² near the area where they're known.
 * Being denser doesn't count when the newest survey is wanted.
 */
export function advantage(candidate: Candidate, current: Candidate, density: (c: Candidate) => number | undefined = (c) => c.densityM2, newestOnly = false): 'newer' | 'denser' | null {
  const started = year(candidate.acquisitionStart) ?? surveyYear(candidate);
  const ended = year(current.acquisitionEnd) ?? surveyYear(current);
  if (started !== null && ended !== null && started - ended >= NEWER_YEARS) return 'newer';
  if (newestOnly) return null;
  const [a, b] = [density(candidate), density(current)];
  if (a && b && a >= DENSITY_RATIO * b && a - b >= DENSITY_GAIN) return 'denser';
  return null;
}

/** A LiDAR only model with nothing to read but offered tiles. */
export class OffersError extends Error {
  constructor(
    message: string,
    readonly offers: LidarOffer[],
  ) {
    super(message);
    this.name = 'OffersError';
  }
}

export function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** "4 tiles, about 620 MB, from Geobasis NRW (2021)", for messages and the CLI. */
export function describeOffer(offer: LidarOffer): string {
  const count = `${offer.tiles.length} ${offer.tiles.length === 1 ? 'tile' : 'tiles'}`;
  const size = offer.bytes ? `, about ${formatSize(offer.bytes)}${offer.unsized ? ` and ${offer.unsized} of unknown size` : ''}` : '';
  return `${count}${size}, from ${offer.name}${offer.year ? ` (${offer.year})` : ''}`;
}

/**
 * Why a survey's tiles couldn't be read, found from one tile's header, so a
 * download that would fail isn't offered: OpenTopography's Indiana tiles
 * give no height units, and they're 300 MB each. A network error says
 * nothing about the files.
 */
export async function unreadable(fetcher: Fetcher, survey: Candidate, tiles: Tile[]): Promise<string | null> {
  if (!tiles.length) return null;
  try {
    await checkTile(fetcher, tiles[0], survey);
    return null;
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    if (error instanceof HttpError || error instanceof NetworkError) return null;
    return (error as Error).message;
  }
}

// Sizes of tiles the catalog didn't give are asked for, a few at a time.
const MAX_ASKED = 24;

/** An offer of `tiles` from `survey`, with what they come to, or null when it couldn't be read anyway (which goes in `failures`). */
export async function makeOffer(fetcher: Fetcher, survey: Candidate, tiles: Tile[], reason: LidarOffer['reason'], failures: Failure[], buildings?: number): Promise<LidarOffer | null> {
  const unique = [...new Map(tiles.map((t) => [tileKey(t), t])).values()];
  const problem = await unreadable(fetcher, survey, unique);
  if (problem) {
    failures.push({ source: survey.name, reason: problem });
    return null;
  }
  let bytes = 0;
  let unsized = 0;
  const unknown: Tile[] = [];
  for (const tile of unique) {
    const size = tile.bytes ?? (tile.member ? undefined : tile.size);
    if (size) bytes += size;
    else unknown.push(tile);
  }
  // A member's own size isn't the ZIP's, so only files on their own are asked about.
  const asked = unknown.filter((t) => !t.member).slice(0, MAX_ASKED);
  const sizes = await Promise.all(asked.map((t) => fetcher.size(t.url).catch(() => 0)));
  for (const size of sizes) bytes += size;
  unsized = unknown.length - sizes.filter((size) => size > 0).length;
  return {
    url: survey.url,
    provider: survey.provider,
    name: survey.name,
    year: surveyYear(survey),
    attribution: survey.attribution,
    sourcePage: survey.sourcePage,
    license: survey.license,
    tiles: unique.map(tileKey),
    bytes,
    unsized,
    buildings,
    reason,
  };
}
