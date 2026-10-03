import { execSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(__dirname, '..');

console.log('Stopping previous test server processes...');
try {
  execSync(
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -match \'dist[\\\\/]main.js|mock-supabase|m50-simulator\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"',
    { stdio: 'ignore' }
  );
} catch {}

console.log('Building Nest API...');
execSync('npx nest build', { cwd: apiDir, stdio: 'inherit' });

console.log('Resetting Postgres database...');
const sql = [
  'ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_mutation;',
  "DO $$ DECLARE t text; BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' LOOP EXECUTE format('TRUNCATE %I CASCADE', t); END LOOP; END $$;",
  'ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_mutation;'
].join(' ');
execSync(`docker exec att-pg psql -U postgres -q -c "${sql}"`, { stdio: 'inherit' });

console.log('Flushing Redis...');
execSync('docker exec att-redis redis-cli FLUSHALL', { stdio: 'inherit' });

console.log('Starting mock Supabase...');
const mockProcess = spawn('node', [path.join(__dirname, 'mock-supabase.mjs')], {
  cwd: apiDir,
  detached: true,
  stdio: 'ignore'
});
mockProcess.unref();

console.log('Starting API...');
const env = {
  ...process.env,
  PORT: '8040',
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://app_user:app@localhost:55432/postgres',
  DIRECT_URL: 'postgresql://postgres:postgres@localhost:55432/postgres',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '56379',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
  SUPABASE_JWKS_URL: 'http://localhost:54321/auth/v1/.well-known/jwks.json',
};
const apiProcess = spawn('node', ['dist/main.js'], {
  cwd: apiDir,
  env,
  detached: true,
  stdio: 'ignore'
});
apiProcess.unref();

console.log('Waiting for API readiness...');
const deadline = Date.now() + 60000;
let ready = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const res = await fetch('http://localhost:8040/v1/health/ready');
    const data = await res.json();
    if (data.status === 'ok') {
      ready = true;
      break;
    }
  } catch {}
}

if (!ready) {
  console.error('API failed to start within timeout.');
  process.exit(1);
}
console.log('API is ready!');
