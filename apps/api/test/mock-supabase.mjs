// Minimal Supabase stand-in for local smoke tests: JWKS, auth admin, password grant, storage.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/eshwa/Repos/iverto-att/apps/api/package.json');
const jose = require('jose');

const PORT = Number(process.env.MOCK_PORT || 54321);
const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
const jwk = { ...(await jose.exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const users = new Map(); // id -> {id,email,password,app_metadata,banned}
const files = new Map();

const token = (u) =>
  new jose.SignJWT({ email: u.email, app_metadata: u.app_metadata, role: 'authenticated' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject(u.id).setIssuedAt().setExpirationTime('1h').setAudience('authenticated').sign(privateKey);

const body = (req) => new Promise((r) => { let b = []; req.on('data', (c) => b.push(c)); req.on('end', () => r(Buffer.concat(b))); });
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const pub = (u) => ({ id: u.id, email: u.email, app_metadata: u.app_metadata, user_metadata: {}, aud: 'authenticated', created_at: new Date().toISOString() });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const raw = await body(req);
  const data = raw.length && (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw) : null;
  if (p === '/auth/v1/.well-known/jwks.json') return json(res, 200, { keys: [jwk] });
  if (p === '/auth/v1/admin/users' && req.method === 'POST') {
    if ([...users.values()].some((u) => u.email === data.email)) return json(res, 422, { code: 422, msg: 'A user with this email address has already been registered', error_code: 'email_exists' });
    const u = { id: randomUUID(), email: data.email, password: data.password, app_metadata: data.app_metadata || {} };
    users.set(u.id, u);
    return json(res, 200, pub(u));
  }
  const m = p.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/);
  if (m) {
    const u = users.get(m[1]);
    if (!u) return json(res, 404, { code: 404, msg: 'User not found' });
    if (req.method === 'GET') return json(res, 200, pub(u));
    if (req.method === 'DELETE') { users.delete(u.id); return json(res, 200, {}); }
    if (req.method === 'PUT') {
      if (data.password) { if (data.password.length < 10) return json(res, 422, { code: 422, msg: 'Password should be at least 10 characters' }); u.password = data.password; }
      if (data.app_metadata) u.app_metadata = { ...u.app_metadata, ...data.app_metadata };
      if (data.ban_duration) u.banned = data.ban_duration !== 'none';
      return json(res, 200, pub(u));
    }
  }
  if (p === '/auth/v1/token') {
    const u = [...users.values()].find((x) => x.email === data.email && x.password === data.password && !x.banned);
    if (!u) return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    return json(res, 200, { access_token: await token(u), token_type: 'bearer', expires_in: 3600, refresh_token: 'r', user: pub(u) });
  }
  // test helper: set a password without the API (to seed)
  if (p === '/test/users') return json(res, 200, [...users.values()]);
  const up = p.match(/^\/storage\/v1\/object\/(?!sign\/)([^/]+)\/(.+)$/);
  if (up && req.method === 'POST') { files.set(`${up[1]}/${up[2]}`, raw); return json(res, 200, { Key: `${up[1]}/${up[2]}`, Id: randomUUID() }); }
  const sign = p.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
  if (sign && req.method === 'POST') return json(res, 200, { signedURL: `/object/sign/${sign[1]}/${sign[2]}?token=t` });
  if (p.startsWith('/storage/v1/object/sign/') && req.method === 'GET') { const k = p.replace('/storage/v1/object/sign/', ''); const f = files.get(k); res.writeHead(f ? 200 : 404); return res.end(f); }
  if (p.startsWith('/storage/v1/object/') && req.method === 'DELETE') return json(res, 200, []);
}).listen(PORT, '0.0.0.0', () => console.log(`mock supabase on ${PORT}`));
