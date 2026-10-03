/**
 * Create (or reset) a platform admin — Iverto staff only, never through the UI (§13.1).
 *
 *   npm run platform:admin -- --email ops@iverto.ai --name "Ops"
 *
 * Prints a temporary password once; the admin must change it at first login.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';
import { temporaryPassword } from '../src/users/users.service';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name') ?? email;
  if (!email) throw new Error('Usage: npm run platform:admin -- --email <email> [--name <name>]');

  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const password = temporaryPassword();
  const app_metadata = { is_super_admin: true, role: 'PLATFORM_ADMIN', must_change_password: true };

  const db = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await db.connect();
  try {
    const existing = await db.query('SELECT user_id FROM user_profiles WHERE email = $1 AND role = $2', [email, 'PLATFORM_ADMIN']);
    let userId: string;
    if (existing.rows[0]) {
      userId = existing.rows[0].user_id;
      const { error } = await supabase.auth.admin.updateUserById(userId, { password, app_metadata });
      if (error) throw error;
    } else {
      const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true, app_metadata });
      if (error) throw error;
      userId = data.user.id;
      await db.query(
        `INSERT INTO user_profiles (user_id, tenant_id, role, display_name, email, site_ids, status, must_change_password)
         VALUES ($1, NULL, 'PLATFORM_ADMIN', $2, $3, '{}', 'ACTIVE', true)`,
        [userId, name, email],
      );
    }
    await db.query(
      `INSERT INTO audit_logs (id, tenant_id, actor_type, action, target_type, target_id, payload)
       VALUES (gen_random_uuid()::text, NULL, 'system', 'PLATFORM_ADMIN_SEEDED', 'UserProfile', $1, $2)`,
      [userId, JSON.stringify({ email })],
    );
    console.log(`Platform admin ${email} (${userId})\nTemporary password: ${password}`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
