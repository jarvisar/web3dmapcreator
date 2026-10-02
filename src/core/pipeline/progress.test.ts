import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgressEvent } from '../engine/protocol';
import { Progress } from './context';

let clock = 0;

beforeEach(() => {
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function recorder(speed?: number) {
  const events: ProgressEvent[] = [];
  const progress = new Progress((event) => events.push(event), { speed });
  const last = () => events[events.length - 1];
  return { progress, events, last };
}

/** Moves the clock on and reports, past the 50 ms between sends. */
function at(progress: Progress, seconds: number, fraction: number) {
  clock = seconds * 1000;
  progress.report(fraction);
}

describe('Progress', () => {
  it('shares the bar out by the planned seconds', () => {
    const { progress, last } = recorder();
    progress.plan([
      { stage: 'roads', seconds: 1 },
      { stage: 'buildings', seconds: 3 },
    ]);
    progress.begin('roads', 'Roads');
    expect(last().fraction).toBe(0);
    at(progress, 0.5, 0.5);
    expect(last().fraction).toBeCloseTo(0.125);
    clock = 1000;
    progress.begin('buildings', 'Buildings');
    expect(last().fraction).toBeCloseTo(0.25);
    at(progress, 2.5, 0.5);
    expect(last().fraction).toBeCloseTo(0.625);
  });

  it('never goes back when a step turns out longer', () => {
    const { progress, events } = recorder();
    progress.plan([
      { stage: 'data', seconds: 1, wait: true },
      { stage: 'roads', seconds: 1 },
    ]);
    progress.begin('data', 'Downloading');
    at(progress, 0.6, 0.9);
    // The download's total grew, so its fraction fell back.
    at(progress, 1.2, 0.3);
    // A plan revised up mid-step.
    progress.plan([{ stage: 'roads', seconds: 20 }]);
    at(progress, 2, 0.5);
    clock = 3000;
    progress.begin('roads', 'Roads');
    at(progress, 10, 0.4);
    for (let i = 1; i < events.length; i++) expect(events[i].fraction).toBeGreaterThanOrEqual(events[i - 1].fraction);
  });

  it('keeps the bar where it is when an estimate changes, and shares out the rest', () => {
    const { progress, last } = recorder();
    progress.plan([
      { stage: 'roads', seconds: 2 },
      { stage: 'mesh', seconds: 2 },
    ]);
    progress.begin('roads', 'Roads');
    clock = 2000;
    progress.begin('mesh', 'Meshing');
    expect(last().fraction).toBeCloseTo(0.5);
    // Meshing turns out to be three times the work: the bar stays at half and slows.
    progress.plan([{ stage: 'mesh', seconds: 6 }]);
    at(progress, 2.1, 0);
    expect(last().fraction).toBeCloseTo(0.5);
    at(progress, 5, 0.5);
    expect(last().fraction).toBeCloseTo(0.75);
  });

  it('drops steps that never run and holds the bar over ones not planned', () => {
    const { progress, last } = recorder();
    progress.plan([
      { stage: 'roads', seconds: 1 },
      { stage: 'bridges', seconds: 1 },
      { stage: 'buildings', seconds: 2 },
    ]);
    progress.begin('roads', 'Roads');
    clock = 1000;
    progress.begin('footprints', 'Unplanned');
    const held = last().fraction;
    at(progress, 1.5, 0.5);
    expect(last().fraction).toBe(held);
    clock = 2000;
    progress.begin('buildings', 'Buildings');
    // Bridges never ran, so buildings take the rest of the bar.
    at(progress, 3, 0.5);
    expect(last().fraction).toBeCloseTo(held + (1 - held) / 2);
  });

  it('gives no time left while a guess is ahead', () => {
    const { progress, last } = recorder();
    progress.plan([
      { stage: 'data', seconds: 5, wait: true, guess: true },
      { stage: 'roads', seconds: 1, guess: true },
    ]);
    progress.begin('data', 'Downloading');
    at(progress, 2, 0.4);
    expect(last().remaining).toBeUndefined();
    progress.plan([{ stage: 'roads', seconds: 1 }]);
    at(progress, 3, 0.6);
    // The download's own pace (0.2 a second) gives 2 s, then a second of roads.
    expect(last().remaining).toBeCloseTo(3, 0);
  });

  it('takes the pace over from a guess', () => {
    const { progress, last } = recorder();
    progress.plan([{ stage: 'lidar', seconds: 100, wait: true, guess: true }]);
    progress.begin('lidar', 'Reading');
    at(progress, 0.5, 0.05);
    expect(last().remaining).toBeUndefined();
    at(progress, 10, 0.5);
    expect(last().remaining).toBeCloseTo(10, 0);
  });

  it('gives no time left over a step that was never planned, until it shows its pace', () => {
    const { progress, last } = recorder();
    progress.plan([{ stage: 'mesh', seconds: 2 }]);
    progress.begin('surveys', 'Finding LiDAR surveys');
    at(progress, 0.5, 0.1);
    expect(last().remaining).toBeUndefined();
    at(progress, 2, 0.5);
    expect(last().remaining).toBeCloseTo(4, 0);
  });

  it('reads a stalled step from its average pace', () => {
    const { progress, last } = recorder();
    progress.plan([{ stage: 'lidar', seconds: 100, wait: true, guess: true }]);
    progress.begin('lidar', 'Reading');
    at(progress, 10, 0.5);
    // A block that takes a long time: nothing moves for 20 s.
    at(progress, 30, 0.5);
    expect(last().remaining).toBeCloseTo(30, 0);
  });

  it("doesn't jump when a guess ends early or stuck", () => {
    const { progress, last } = recorder();
    progress.plan([
      { stage: 'surveys', seconds: 8, wait: true, guess: true },
      { stage: 'mesh', seconds: 2 },
    ]);
    progress.begin('surveys', 'Finding LiDAR surveys');
    at(progress, 1, 0.6);
    const before = last().fraction;
    // Stuck at 0.6 for a long time, then done.
    at(progress, 100, 0.6);
    clock = 200_000;
    progress.begin('mesh', 'Meshing');
    expect(last().fraction).toBeCloseTo(before, 6);
  });

  it('scales the work ahead by how this machine compares', () => {
    const { progress, last } = recorder();
    progress.plan([
      { stage: 'roads', seconds: 2 },
      { stage: 'buildings', seconds: 4 },
    ]);
    progress.begin('roads', 'Roads');
    at(progress, 4, 0.99);
    // Twice as slow as planned, with the prior pulling it back a little.
    clock = 4000;
    progress.begin('buildings', 'Buildings');
    expect(progress.speed).toBeCloseTo(1.5);
    expect(last().remaining).toBeCloseTo(6);
  });

  it('starts from a speed it was given', () => {
    const { progress, last } = recorder(2);
    progress.plan([{ stage: 'mesh', seconds: 3 }]);
    progress.begin('mesh', 'Meshing');
    expect(last().remaining).toBeCloseTo(6);
  });
});
