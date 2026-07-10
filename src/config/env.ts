import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),

  // Postgres. In docker-compose this points at the `db` service.
  DATABASE_URL: z.string().url(),

  // Secret for the session JWTs this API issues. Use a long random string
  // (e.g. `openssl rand -base64 48`).
  JWT_SECRET: z.string().min(16),

  // How long a session token stays valid (ms/vercel-style duration string).
  JWT_TTL: z.string().default('7d'),

  // Comma-separated list of allowed browser origins for CORS, e.g.
  // "https://app.example.com,https://admin.example.com".
  // Empty (the default) reflects any origin — fine for development, but set
  // this in production.
  CORS_ORIGINS: z.string().default(''),

  // Emails granted admin on first sign-in (comma-separated).
  ADMIN_EMAILS: z.string().default(''),

  // OAuth audiences (validate incoming Google/Apple id tokens).
  GOOGLE_CLIENT_ID: z.string().optional(),
  APPLE_CLIENT_ID: z.string().optional(),

  // TODO: add payment gateway config (e.g. IOKA_API_KEY) when you wire payments.
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const adminEmails = env.ADMIN_EMAILS.split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
