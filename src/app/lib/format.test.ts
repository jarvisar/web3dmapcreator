import { describe, expect, it } from 'vitest';
import { formatRatio, formatTimeLeft, parseDecimal } from './format';

describe('formatTimeLeft', () => {
  it('rounds up to five seconds under a minute, then to minutes', () => {
    expect(formatTimeLeft(3)).toBe('a few seconds left');
    expect(formatTimeLeft(21)).toBe('about 25 s left');
    expect(formatTimeLeft(55)).toBe('about 55 s left');
    // Never "about 60 s".
    expect(formatTimeLeft(55.5)).toBe('about 1 min left');
    expect(formatTimeLeft(59.9)).toBe('about 1 min left');
    expect(formatTimeLeft(89)).toBe('about 1 min left');
    expect(formatTimeLeft(150)).toBe('about 3 min left');
    expect(formatTimeLeft(3 * 3600 + 20 * 60)).toBe('about 3 h 20 min left');
  });
});

describe('parseDecimal', () => {
  it('reads a comma as a decimal point unless it groups thousands', () => {
    expect(parseDecimal('0,4')).toBe(0.4);
    expect(parseDecimal('1,5')).toBe(1.5);
    expect(parseDecimal('0.07')).toBe(0.07);
    expect(parseDecimal('0,075')).toBe(0.075);
    expect(parseDecimal('-0,125')).toBe(-0.125);
    expect(parseDecimal('5,000')).toBe(5000);
    expect(parseDecimal('1,250.5')).toBe(1250.5);
    expect(parseDecimal(' 12 ')).toBe(12);
  });

  it('accepts unicode minus signs and rejects junk', () => {
    expect(parseDecimal('−3')).toBe(-3);
    expect(parseDecimal('1,2,3')).toBeNull();
    expect(parseDecimal('abc')).toBeNull();
    expect(parseDecimal('')).toBeNull();
  });
});

describe('formatRatio', () => {
  it('turns mm per metre into a map scale', () => {
    expect(formatRatio(0.07)).toBe('1:14,286');
    expect(formatRatio(0)).toBe('1:?');
  });
});
