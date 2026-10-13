/**
 * The test database URL. Refuses anything whose name does not end in _test or
 * _ci so a misconfigured shell can never truncate a real environment.
 */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Set TEST_DATABASE_URL (e.g. postgres://postgres:postgres@localhost:5433/visaitaly_test).',
    );
  }
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!/_(test|ci)$/.test(name)) {
    throw new Error(`Refusing to run tests against "${name}": database name must end in _test or _ci.`);
  }
  return url;
}
