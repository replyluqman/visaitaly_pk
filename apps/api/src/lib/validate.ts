import type { z } from 'zod';
import { AppError } from './errors.js';

/**
 * Parse untrusted input against a zod schema.
 * Throws AppError(VALIDATION_FAILED) with field-level details on failure —
 * never leaks the raw zod error to the client.
 */
export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const details: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    (details[key] ??= []).push(issue.message);
  }
  throw AppError.validation(details);
}

/** For endpoints whose body is optional: an empty body is `{}`, a non-empty one must still be valid JSON. */
export async function optionalJsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw AppError.validation({ _: ['Body must be valid JSON.'] });
  }
}

/** Body parser that treats malformed JSON as a validation error, not a 500. */
export async function jsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw AppError.validation({ _: ['Body must be valid JSON.'] });
  }
}
