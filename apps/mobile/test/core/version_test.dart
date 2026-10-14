import 'package:flutter_test/flutter_test.dart';
import 'package:visaitaly_pk/core/version.dart';

/// Mirrors apps/api/test/version.test.ts — the two implementations must agree.
void main() {
  test('parses major[.minor[.patch[.build]]] and ignores -pre / +build', () {
    expect(parseVersion('1'), [1, 0, 0, 0]);
    expect(parseVersion('1.2.3+45'), [1, 2, 3, 0]);
    expect(parseVersion('2.0.0-beta.1'), [2, 0, 0, 0]);
    expect(parseVersion('1.2.3.4'), [1, 2, 3, 4]);
  });

  test('numeric, not lexicographic: 1.10.0 is newer than 1.9.0', () {
    expect(isBelowMinimum('1.9.0', '1.10.0'), isTrue);
    expect(isBelowMinimum('1.10.0', '1.9.0'), isFalse);
    expect(isBelowMinimum('1.0', '1.0.0'), isFalse);
  });

  test('fails open on anything unparsable', () {
    for (final bad in ['', 'abc', 'v1.2.3', '1..2', '1.2.x', '-1.0.0']) {
      expect(parseVersion(bad), isNull, reason: bad);
      expect(isBelowMinimum(bad, '5.0.0'), isFalse, reason: bad);
    }
    expect(isBelowMinimum('1.0.0', 'garbage'), isFalse);
  });

  test('0.0.0 blocks nobody; equal is allowed', () {
    expect(isBelowMinimum('0.1.0', '0.0.0'), isFalse);
    expect(isBelowMinimum('1.5.0', '1.5.0'), isFalse);
    expect(isBelowMinimum('1.4.9', '1.5.0'), isTrue);
  });
}
