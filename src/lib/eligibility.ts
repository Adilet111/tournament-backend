import { z } from 'zod';

/**
 * Tournament eligibility bounds (rating + age).
 *
 * Both rating and age are stored as an inclusive [min, max] range on the
 * tournament. "Open on a side" is expressed as the sentinel extreme, so an
 * unrestricted tournament is `min = *_OPEN_MIN`, `max = *_OPEN_MAX` and every
 * player passes. These are the column defaults in the schema too.
 */
export const RATING_OPEN_MIN = 0;
export const RATING_OPEN_MAX = 100000; // well above any sport's rating CAP (2500)
export const AGE_OPEN_MIN = 0;
export const AGE_OPEN_MAX = 120;

export function hasRatingBound(minRating: number, maxRating: number): boolean {
  return minRating > RATING_OPEN_MIN || maxRating < RATING_OPEN_MAX;
}

export function hasAgeBound(minAge: number, maxAge: number): boolean {
  return minAge > AGE_OPEN_MIN || maxAge < AGE_OPEN_MAX;
}

/**
 * Completed years between a `YYYY-MM-DD` birth date and `on`. Uses UTC parts so
 * it doesn't drift with the server timezone (the birth_date column is date-only).
 */
export function ageFromBirthDate(birthDate: string, on: Date): number {
  const [y, m, d] = birthDate.split('-').map(Number);
  let age = on.getUTCFullYear() - y;
  const monthDiff = on.getUTCMonth() + 1 - m;
  if (monthDiff < 0 || (monthDiff === 0 && on.getUTCDate() < d)) age -= 1;
  return age;
}

/** A `YYYY-MM-DD` string that parses to a real, non-future calendar date. */
export const birthDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'birthDate must be YYYY-MM-DD')
  .refine((s) => {
    const t = Date.parse(`${s}T00:00:00Z`);
    return !Number.isNaN(t) && t <= Date.now();
  }, 'birthDate must be a valid, non-future date');
