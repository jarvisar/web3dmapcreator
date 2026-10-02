import { describe, expect, it } from 'vitest';
import { localSuggestion } from './PlaceSearch';

describe('typed coordinates', () => {
  it('read latitude, longitude', () => {
    expect(localSuggestion('41.88, -87.63')).toEqual({ kind: 'point', key: 'point', center: [-87.63, 41.88] });
  });

  it('read longitude first when the other way is no place a model can be', () => {
    // A latitude past the map's edge, and one past 90.
    expect(localSuggestion('-87.63 41.88')).toMatchObject({ kind: 'point', center: [-87.63, 41.88], swapped: true });
    expect(localSuggestion('-122.42, 37.77')).toMatchObject({ kind: 'point', center: [-122.42, 37.77], swapped: true });
  });

  it('say when neither way can be modelled', () => {
    expect(localSuggestion('88, 89')).toMatchObject({ kind: 'invalid', title: 'Too close to the poles' });
  });

  it('leave addresses and bounds as they were', () => {
    expect(localSuggestion('221B Baker Street')).toBeNull();
    expect(localSuggestion('-87.64,41.87,-87.61,41.89')).toMatchObject({ kind: 'bounds' });
  });
});
