import { describe, expect, it } from 'vitest';
import { formatRatio, parseDecimal } from './format';

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
