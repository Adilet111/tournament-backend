import { z } from 'zod';
import { AppError } from './errors';

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ');
    throw new AppError(msg || 'invalid request', 400);
  }
  return result.data;
}
