import { sql, type SQL } from 'drizzle-orm';

/** SQL expressions for the applicant-side inputs of requirement applicability. */
export interface ApplicabilityInputs {
  category: SQL;
  location: SQL;
  nullaOstaStatus: SQL;
  dateOfBirth: SQL;
}

/**
 * The single definition of "does requirement `r` apply to this profile".
 * Used by case generation (columns of `applicants`) and by the public Quick Check
 * (bound parameters) so the two can never disagree about what a profile needs.
 *
 * An unknown input (NULL — e.g. a Quick Check that did not ask about location, or an
 * unknown date of birth) never excludes an item: we would rather show than hide
 * something that may be required.
 */
export function requirementApplies(i: ApplicabilityInputs, r = sql.raw('r')): SQL {
  return sql`(
    (CASE ${i.category}
       WHEN 'spouse' THEN ${r}.applies_spouse
       WHEN 'child'  THEN ${r}.applies_child
       WHEN 'parent' THEN ${r}.applies_parent
     END)
    AND (${r}.applies_locations IS NULL OR ${i.location} IS NULL
         OR ${i.location} = ANY (${r}.applies_locations))
    AND (${r}.requires_nulla_osta_status IS NULL OR ${i.nullaOstaStatus} IS NULL
         OR ${i.nullaOstaStatus} = ANY (${r}.requires_nulla_osta_status))
    AND (${r}.min_age_years IS NULL OR ${i.dateOfBirth} IS NULL
         OR date_part('year', age(CURRENT_DATE, ${i.dateOfBirth})) >= ${r}.min_age_years)
    AND (${r}.max_age_years IS NULL OR ${i.dateOfBirth} IS NULL
         OR date_part('year', age(CURRENT_DATE, ${i.dateOfBirth})) <= ${r}.max_age_years)
  )`;
}
