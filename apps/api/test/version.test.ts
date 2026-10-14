import { describe, expect, it } from 'vitest';
import { compareVersions, isBelowMinimum, parseVersion } from '../src/lib/version.js';

describe('version comparison (minimum-app-version gate)', () => {
  it('parses major[.minor[.patch[.build]]] and ignores -pre / +build suffixes', () => {
    expect(parseVersion('1')).toEqual([1, 0, 0, 0]);
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3, 0]);
    expect(parseVersion('1.2.3+45')).toEqual([1, 2, 3, 0]);
    expect(parseVersion('2.0.0-beta.1')).toEqual([2, 0, 0, 0]);
    expect(parseVersion('1.2.3.4')).toEqual([1, 2, 3, 4]);
  });

  it('compares numerically, not as strings (1.10.0 > 1.9.0)', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.9.9', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });

  it('fails OPEN on anything unparsable: a weird version string never locks a user out', () => {
    for (const bad of ['', 'abc', 'v1.2.3', '1..2', '1.2.x', '-1.0.0', '9999999.0.0']) {
      expect([bad, parseVersion(bad)]).toEqual([bad, null]);
      expect(isBelowMinimum(bad, '5.0.0')).toBe(false);
    }
    expect(isBelowMinimum('1.0.0', 'garbage')).toBe(false);
  });

  it('isBelowMinimum: only a clearly older build is blocked; 0.0.0 blocks nobody', () => {
    expect(isBelowMinimum('1.4.9', '1.5.0')).toBe(true);
    expect(isBelowMinimum('1.5.0', '1.5.0')).toBe(false);
    expect(isBelowMinimum('0.0.1', '0.0.0')).toBe(false);
    expect(isBelowMinimum('0.1.0', '0.0.0')).toBe(false);
  });
});
