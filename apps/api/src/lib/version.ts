/**
 * App version comparison for the minimum-version gate (ADR 0013).
 * Accepts `major[.minor[.patch[.build]]]`, ignoring any `-pre` / `+build` suffix ("1.2.3+45" → 1.2.3).
 * Returns null for anything unparsable — the gate then FAILS OPEN: a weird version string must not lock a
 * user out; only a clearly-older build is blocked.
 */
export function parseVersion(v: string): number[] | null {
  const m = /^(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:[-+].*)?$/.exec(v.trim());
  if (!m) return null;
  return [1, 2, 3, 4].map((i) => Number(m[i] ?? 0));
}

/** <0 if a<b, 0 if equal, >0 if a>b; null if either side is unparsable. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  }
  return 0;
}

export function isBelowMinimum(appVersion: string, minVersion: string): boolean {
  const c = compareVersions(appVersion, minVersion);
  return c !== null && c < 0;
}
