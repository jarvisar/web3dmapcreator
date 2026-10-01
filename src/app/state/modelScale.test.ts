import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_SIDE_M, effectiveScale } from '../../core/geo/area';
import { DEFAULT_SETTINGS } from '../../core/settings';
import { scaleArea } from '../lib/area';
import { areaResizable, scaleLocked, setArea, setOutput, setPrintedSide, setScale, setScaleLock, snapshotKey, useApp } from './store';

const state = () => useApp.getState();
const scaleNow = () => effectiveScale(state().area, state().settings.scale);
const printed = () => [state().area.widthM * scaleNow(), state().area.heightM * scaleNow()];

describe('the scale lock on a model', () => {
  beforeEach(() => {
    setOutput('model');
    useApp.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
    setArea((area) => ({ ...area, shape: 'rectangle', widthM: 3000, heightM: 2000 }));
  });

  it('starts locked, with the printed size following, as before', () => {
    expect(scaleLocked(state())).toBe(true);
    expect(areaResizable(state())).toBe(true);
    setScale(0.14);
    expect(state().area.widthM).toBe(3000);
    expect(printed()[0]).toBeCloseTo(420, 6);
    setPrintedSide('width', 420);
    expect(state().area.widthM).toBeCloseTo(3000, 1);
  });

  it('keeps the printed size once unlocked, without changing the model', () => {
    const key = snapshotKey(state().area, state().settings);
    const before = scaleNow();
    setScaleLock(false);
    expect(scaleLocked(state())).toBe(false);
    expect(scaleNow()).toBeCloseTo(before, 12);
    expect(snapshotKey(state().area, state().settings)).toBe(key);
    setScaleLock(true);
    expect(state().settings.scale).toMatchObject({ mode: 'fixed', mmPerMetre: before });
    expect(snapshotKey(state().area, state().settings)).toBe(key);
  });

  it('resizes the area for a new scale while unlocked', () => {
    setScaleLock(false);
    const size = printed();
    const centre = state().area.center;
    setScale(0.14);
    expect(scaleNow()).toBeCloseTo(0.14, 9);
    expect(state().area.widthM).toBeCloseTo(1500, 1);
    expect(state().area.heightM).toBeCloseTo(1000, 1);
    expect(state().area.center).toEqual(centre);
    expect(printed()[0]).toBeCloseTo(size[0], 2);
  });

  it('lets the scale follow the box and a typed size while unlocked', () => {
    setScaleLock(false);
    const size = printed()[0];
    setArea((area) => ({ ...area, widthM: 6000, heightM: 4000 }));
    expect(printed()[0]).toBeCloseTo(size, 6);
    expect(scaleNow()).toBeCloseTo(0.035, 9);
    setPrintedSide('width', 420);
    expect(state().area.widthM).toBe(6000);
    expect(scaleNow()).toBeCloseTo(0.07, 9);
  });

  it('stops at the area limits without changing the proportions', () => {
    setScaleLock(false);
    setScale(0.001);
    expect(state().area.widthM).toBeCloseTo(MAX_SIDE_M, 1);
    expect(state().area.heightM / state().area.widthM).toBeCloseTo(2 / 3, 6);
  });

  it('scales round and hexagonal areas whole', () => {
    const hex = scaleArea({ center: [0, 0], widthM: 2000, heightM: 2000 * (Math.sqrt(3) / 2), rotationDeg: 0, shape: 'hexagon', cornerRadius: 0 }, 0.5);
    expect(hex.heightM / hex.widthM).toBeCloseTo(Math.sqrt(3) / 2, 9);
    expect(scaleArea({ center: [0, 0], widthM: 100, heightM: 60, rotationDeg: 0, shape: 'rectangle', cornerRadius: 0 }, 0.1).heightM).toBe(50);
  });
});

describe('the same lock on an SVG map', () => {
  beforeEach(() => setOutput('svg'));

  it('fixes the box while locked, since the piece keeps its size too', () => {
    setScaleLock(true);
    expect(state().svg.scaleLocked).toBe(true);
    expect(areaResizable(state())).toBe(false);
    setScaleLock(false);
    expect(state().svg.scaleLocked).toBe(false);
    expect(areaResizable(state())).toBe(true);
  });

  it('resizes the area for a new scale, locked or not', () => {
    for (const locked of [true, false]) {
      setScaleLock(locked);
      const width = state().area.widthM;
      setScale((1000 / state().svg.scale) * 2);
      expect(state().area.widthM).toBeCloseTo(width / 2, 0);
    }
  });
});
