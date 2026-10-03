/**
 * Applies prisma/post-init/*.sql in order after `prisma migrate deploy`.
 * Every file is idempotent, so this runs on every deploy.
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

async function main() {
  const client = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await client.connect();
  const dir = join(__dirname, '..', 'prisma', 'post-init');
  try {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      process.stdout.write(`post-init ${file} … `);
      await client.query(readFileSync(join(dir, file), 'utf8'));
      console.log('ok');
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
