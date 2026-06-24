import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { env } from '../config/env';

async function main() {
  const sql = postgres(env.DATABASE_URL, { max: 1 });
  await migrate(drizzle(sql), { migrationsFolder: './drizzle' });
  await sql.end();
}

main()
  .then(() => {
    console.log('Migrations applied.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
