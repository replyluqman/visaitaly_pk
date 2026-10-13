import { sql, type SQL } from 'drizzle-orm';

/**
 * A Postgres array from a JS array.
 *
 * Drizzle's `sql` template expands an interpolated JS array into a parenthesised *record*
 * (`($1, $2, $3)`), which Postgres refuses to cast to `uuid[]`/`text[]`/`int[]`
 * ("cannot cast type record to integer[]"). Build `ARRAY[$1, $2, …]::<type>[]` explicitly instead;
 * every element is still a bound parameter. `cast` is the ELEMENT type and is not user input.
 */
export function pgArray(items: readonly (string | number)[], cast: 'uuid' | 'text' | 'int'): SQL {
  if (items.length === 0) return sql`'{}'::${sql.raw(cast)}[]`;
  return sql`ARRAY[${sql.join(items.map((i) => sql`${i}`), sql`, `)}]::${sql.raw(cast)}[]`;
}
