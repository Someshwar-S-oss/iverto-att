// End-to-end: leave policy engine, permission hours, geofence, multiple sessions, two-level approval.
// LOCAL ONLY: run after `node test/restart-stack.mjs` (local Postgres :55432, Redis :56379, mock Supabase,
// `node test/mock-blob.mjs` for selfies). Never point this at a shared database.
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/eshwa/Repos/iverto-att/apps/api/package.json');
const { Queue } = require('bullmq');

const API = 'http://127.0.0.1:8040/v1';
const MOCK = 'http://127.0.0.1:54321';
const API_DIR = 'C:/Users/eshwa/Repos/iverto-att/apps/api';
const LOCAL_DB = 'postgresql://postgres:postgres@localhost:55432/postgres';
const env = { ...process.env, SUPABASE_URL: MOCK, SUPABASE_SERVICE_ROLE_KEY: 'x', DIRECT_URL: LOCAL_DB, DATABASE_URL: LOCAL_DB };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`, extra !== undefined ? JSON.stringify(extra).slice(0, 900) : '');
  }
};
async function call(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function login(email, password) {
  const r = await fetch(`${MOCK}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login failed for ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
async function firstLogin(email, temp, next = 'N3w-Passw0rd!x') {
  const t = await login(email, temp);
  const changed = await call(t, 'POST', '/auth/password', { currentPassword: temp, newPassword: next });
  if (changed.status !== 201) throw new Error(`password change failed ${JSON.stringify(changed.body)}`);
  return login(email, next);
}
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(1000);
  }
};
const ist = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const TODAY = ist();
const YESTERDAY = addDays(TODAY, -1);
// Working days (not Sunday) early next month, for quota tests that must share one month.
const nextMonth = (() => { const [y, m] = TODAY.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; })();
const NM = Array.from({ length: 10 }, (_, i) => `${nextMonth}-${String(i + 2).padStart(2, '0')}`).filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() !== 0);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

try {
  console.log('0. Tenant');
  const seed = execSync('npx ts-node scripts/platform-admin.ts --email ops@iverto.test --name Ops', { cwd: API_DIR, env }).toString();
  const platform = await firstLogin('ops@iverto.test', seed.match(/Temporary password: (\S+)/)[1]);
  let r = await call(platform, 'POST', '/platform/tenants', { name: 'Policy Test Co', slug: 'policy-test', site: { name: 'Chennai HQ', timezone: 'Asia/Kolkata' }, admin: { fullName: 'Hema HR', email: 'hema@policy.test' } });
  ok(r.status === 201, 'local test tenant created', r.body);
  const admin = await firstLogin('hema@policy.test', r.body.admin.temporaryPassword);
  const site = (await call(admin, 'GET', '/sites')).body[0];
  const pol = (await call(admin, 'GET', '/attendance-policies')).body[0];
  r = await call(admin, 'PATCH', `/attendance-policies/${pol.id}`, {
    name: 'Default', duplicatePunchSeconds: 0, pairing: 'ALTERNATE', absenceDeduction: 1.5, earlyExitCountsAsLate: true, lateDeduction: 'HALF_DAY', lateDeductionEvery: 1,
  });
  ok(r.status === 200 && r.body.absenceDeduction === 1.5 && r.body.pairing === 'ALTERNATE', 'policy: 1.5× absence deduction, early exit = late, alternate pairing', r.body);
  r = await call(admin, 'PATCH', `/attendance-policies/${pol.id}`, { name: 'Default', pairing: 'SOMETIMES' });
  ok(r.status === 400, 'bad pairing value refused', r.body);

  console.log('1. Employee categories (per organisation)');
  r = await call(admin, 'PATCH', '/org', { employmentTypes: [{ code: 'PERMANENT', label: 'Permanent' }, { code: 'TEMPORARY', label: 'Temporary' }, { code: 'INTERN', label: 'Intern' }], remoteRequiresHrApproval: true });
  ok(r.status === 200, 'categories Permanent / Temporary / Intern saved', r.body);
  r = await call(admin, 'POST', '/employees', { employeeCode: 'X1', fullName: 'Wrong Type', siteId: site.id, joinedOn: '2026-01-01', employmentType: 'FULL_TIME' });
  ok(r.status === 400 && r.body.code === 'UNKNOWN_EMPLOYMENT_TYPE', 'a category the org does not have is refused', r.body);
  const mk = async (code, fullName, employmentType, extra = {}) => (await call(admin, 'POST', '/employees', { employeeCode: code, fullName, siteId: site.id, joinedOn: '2026-01-01', employmentType, ...extra })).body;
  const mgr = await mk('M1', 'Manoj Manager', 'PERMANENT', { email: 'manoj@policy.test' });
  const perm = await mk('P1', 'Pooja Permanent', 'PERMANENT', { managerId: mgr.id, mobilePunch: 'ALWAYS', email: 'pooja@policy.test' });
  const temp = await mk('T1', 'Tarun Temporary', 'TEMPORARY', { managerId: mgr.id });
  const intern = await mk('I1', 'Isha Intern', 'INTERN', { managerId: mgr.id });
  const newbie = await mk('N1', 'Nikhil New', 'PERMANENT', { managerId: mgr.id, joinedOn: TODAY });
  ok([mgr, perm, temp, intern, newbie].every((e) => e.id), 'employees in each category', [mgr, perm, temp, intern, newbie]);
  r = await call(admin, 'POST', '/employees/import', { siteId: site.id, csv: 'employeeCode,fullName,joinedOn,employmentType\nX2,By Label,2026-01-01,Temporary\nX3,Bad,2026-01-01,Contract' });
  ok(r.body.valid === 1 && r.body.invalid === 1 && r.body.errors[0].errors[0].field === 'employmentType', 'import accepts the category label, refuses unknown ones', r.body);
  r = await call(admin, 'PATCH', '/org', { employmentTypes: [{ code: 'PERMANENT', label: 'Permanent' }, { code: 'INTERN', label: 'Intern' }] });
  ok(r.status === 409 && r.body.code === 'EMPLOYMENT_TYPE_IN_USE', 'cannot drop a category employees still have', r.body);

  r = await call(admin, 'POST', '/users', { email: 'manoj@policy.test', displayName: 'Manoj', role: 'MANAGER', employeeId: mgr.id });
  const manager = await firstLogin('manoj@policy.test', r.body.temporaryPassword);
  r = await call(admin, 'POST', '/users', { email: 'pooja@policy.test', displayName: 'Pooja', role: 'EMPLOYEE', employeeId: perm.id });
  const pooja = await firstLogin('pooja@policy.test', r.body.temporaryPassword);

  console.log('2. Leave types: blanket policy per category, probation, hourly permission, LOP');
  r = await call(admin, 'POST', '/leave/types', { code: 'PM', name: 'Permission', unit: 'HOURS', accrualKind: 'YEARLY_UPFRONT' });
  ok(r.status === 400 && r.body.code === 'HOURS_NEED_UNLIMITED', 'an hourly type must be unlimited (no ledger)', r.body);
  r = await call(admin, 'POST', '/leave/types', { code: 'CAS', name: 'Casual leave (ECOG-style)', accrualKind: 'YEARLY_UPFRONT', accrualAmount: 12, entitlements: { TEMPORARY: 5, INTERN: 0 }, minServiceDays: 1 });
  ok(r.status === 201, 'CL: 12/yr, Temporary 5, Intern none, eligible after 1 day', r.body);
  const CL = r.body;
  r = await call(admin, 'POST', '/leave/types', { code: 'PM', name: 'Permission', unit: 'HOURS', accrualKind: 'UNLIMITED', allowHalfDay: false, maxPerMonth: 4, maxRequestsPerMonth: 3 });
  ok(r.status === 201, 'Permission: hourly, 4 h a month in at most 3 requests', r.body);
  const PM = r.body;
  // New tenants get a default LOP type; make it unlimited (no balance at all).
  const LOP = (await call(admin, 'GET', '/leave/types')).body.find((x) => x.code === 'LOP');
  r = await call(admin, 'PATCH', `/leave/types/${LOP.id}`, { code: 'LOP', name: 'Loss of Pay', accrualKind: 'UNLIMITED', active: true });
  ok(r.status === 200 && r.body.accrualKind === 'UNLIMITED', 'default LOP made unlimited', r.body);
  r = await call(admin, 'POST', '/leave/types', { code: 'BAD', name: 'Bad', entitlements: { INTERN: -1 } });
  ok(r.status === 400 && r.body.code === 'BAD_ENTITLEMENTS', 'negative entitlement refused', r.body);

  const q = new Queue('cron', { connection: { host: '127.0.0.1', port: 56379 } });
  await q.add('leave-accrual', {}, { removeOnComplete: true });
  await q.close();
  const avail = async (empId, typeId) => (await call(admin, 'GET', `/leave/balances?employeeId=${empId}`)).body.balances?.find((b) => b.leaveType.id === typeId);
  const permCl = await until(async () => { const b = await avail(perm.id, CL.id); return b?.available === 12 ? b : null; }, 30000);
  ok(permCl?.available === 12 && permCl.entitlement.amount === 12, 'Permanent accrued 12 CL', permCl);
  const tempCl = await until(async () => { const b = await avail(temp.id, CL.id); return b?.available === 5 ? b : null; });
  ok(tempCl?.available === 5, 'Temporary accrued 5 CL (blanket policy, no per-person edits)', tempCl);
  ok((await avail(intern.id, CL.id)) === undefined, 'Intern: CL hidden (not eligible)');
  ok((await avail(newbie.id, CL.id))?.available === 0, 'joined today: no CL until the service period passes');
  const pmRow = await avail(perm.id, PM.id);
  ok(pmRow?.unlimited && pmRow.available === null && pmRow.quota?.limit === 4, 'Permission shows as unlimited with a monthly quota', pmRow);

  r = await call(admin, 'POST', '/leave/entitlements', { employeeId: intern.id, leaveTypeId: CL.id, amount: 3 });
  ok(r.status === 201 && r.body.eligible && r.body.amount === 3 && r.body.overridden, 'per-person override: this intern gets 3 CL', r.body);
  ok((await avail(intern.id, CL.id))?.entitlement.overridden === true, 'override shows in the intern’s balances');
  r = await call(admin, 'POST', '/leave/entitlements', { employeeId: intern.id, leaveTypeId: CL.id, amount: null });
  ok(r.status === 201 && !r.body.eligible, 'override removed: back to the blanket policy (not eligible)', r.body);
  r = await call(admin, 'POST', '/leave/requests/preview', { employeeId: intern.id, leaveTypeId: CL.id, from: NM[0], to: NM[0] });
  ok(r.body.errors?.includes('NOT_ELIGIBLE'), 'intern cannot apply for CL', r.body);
  r = await call(admin, 'POST', '/leave/requests/preview', { employeeId: newbie.id, leaveTypeId: CL.id, from: TODAY, to: TODAY });
  ok(r.body.errors?.includes(`ELIGIBLE_FROM_${addDays(TODAY, 1)}`), 'probation: not eligible before joining + 1 day', r.body);
  r = await call(admin, 'POST', '/leave/requests/preview', { employeeId: intern.id, leaveTypeId: LOP.id, from: NM[0], to: NM[1] });
  ok(r.body.canSubmit && r.body.balances.length === 0, 'intern can take LOP (no balance needed)', r.body);

  console.log('3. Permission: 4 hours a month in at most 3 requests');
  const pm = (date, startTime, endTime, extra = {}) => ({ leaveTypeId: PM.id, from: date, to: date, startTime, endTime, reason: 'personal work', ...extra });
  r = await call(pooja, 'POST', '/mobile/leave/requests/preview', pm(NM[0], '09:00', '10:30', { to: NM[1] }));
  ok(r.status === 400 && r.body.code === 'BAD_RANGE', 'permission is a single day', r.body);
  r = await call(pooja, 'POST', '/mobile/leave/requests/preview', pm(NM[0], '10:30', '09:00'));
  ok(r.status === 400 && r.body.code === 'BAD_TIME_RANGE', 'end must be after start', r.body);
  r = await call(pooja, 'POST', '/mobile/leave/requests', pm(NM[0], '09:00', '10:30'));
  ok(r.status === 201 && r.body.minutes === 90 && r.body.hours === 1.5 && r.body.days === 0, 'request 1: 1.5 h', r.body);
  const pm1 = r.body;
  r = await call(pooja, 'POST', '/mobile/leave/requests', pm(NM[1], '16:00', '17:30'));
  ok(r.status === 201, 'request 2: 1.5 h', r.body);
  const pm2 = r.body;
  r = await call(pooja, 'POST', '/mobile/leave/requests/preview', pm(NM[2], '09:00', '10:30'));
  ok(!r.body.canSubmit && r.body.errors.includes('MONTHLY_LIMIT_EXCEEDED') && r.body.quota.used === 3, '3 h used + 1.5 h > 4 h → refused', r.body);
  r = await call(pooja, 'POST', '/mobile/leave/requests', pm(NM[2], '09:00', '10:00'));
  ok(r.status === 201, 'request 3: 1 h (4 h used)', r.body);
  r = await call(pooja, 'POST', '/mobile/leave/requests/preview', pm(NM[3], '09:00', '09:15'));
  ok(r.body.errors.includes('MONTHLY_REQUESTS_EXCEEDED'), 'a 4th request in the month is refused', r.body);
  r = await call(pooja, 'POST', `/mobile/leave/requests/${pm2.id}/cancel`, {});
  ok(r.status === 201 && r.body.status === 'CANCELLED', 'cancelling one frees its hours and its slot', r.body);
  r = await call(pooja, 'POST', '/mobile/leave/requests/preview', pm(NM[3], '09:00', '10:30'));
  ok(r.body.canSubmit && r.body.quota.requests === 2 && r.body.quota.used === 2.5, 'now 2 requests / 2.5 h used: 1.5 h fits', r.body);
  r = await call(pooja, 'GET', '/mobile/leave/types');
  const pmType = r.body.find?.((t) => t.code === 'PM');
  ok(pmType?.unit === 'HOURS' && pmType.available === null && pmType.quota, 'mobile leave types carry unit + quota', r.body);
  ok(!r.body.some?.((t) => t.code === 'BAD'), 'mobile: only eligible types listed');

  console.log('4. Two-level approval with tracker');
  r = await call(admin, 'PATCH', `/leave/types/${PM.id}`, { code: 'PM', name: 'Permission', requiresHrApproval: true });
  ok(r.status === 200 && r.body.requiresHrApproval, 'Permission now needs manager, then HR', r.body);
  const myReq = async (id) => (await call(pooja, 'GET', '/mobile/leave/requests')).body.data.find((x) => x.id === id);
  let t = (await myReq(pm1.id)).progress;
  ok(t.levels === 2 && t.stage === 'MANAGER' && t.steps.map((s) => s.key).join() === 'SUBMITTED,MANAGER,HR,APPROVED', 'employee sees: with manager', t);
  r = await call(manager, 'POST', `/mobile/approvals/leave/${pm1.id}/reject`, {});
  ok(r.status === 400 && r.body.code === 'REASON_REQUIRED', 'rejecting without a reason is refused', r.body);
  r = await call(manager, 'POST', `/mobile/approvals/leave/${pm1.id}/approve`, {});
  ok(r.status === 201 && r.body.status === 'PENDING' && r.body.managerApproverId, 'manager approves → still pending', r.body);
  t = (await myReq(pm1.id)).progress;
  ok(t.stage === 'HR' && t.steps[1].state === 'done' && t.steps[1].by === 'Manoj', 'employee sees: manager done (Manoj), now with HR', t);
  r = await call(manager, 'GET', '/mobile/approvals?type=leave');
  ok(!r.body.data.some((x) => x.id === pm1.id), 'gone from the manager’s queue');
  r = await call(manager, 'POST', `/mobile/approvals/leave/${pm1.id}/approve`, {});
  ok(r.status === 409 && r.body.code === 'AWAITING_HR', 'manager cannot approve twice', r.body);
  r = await call(admin, 'POST', `/leave/requests/${pm1.id}/approve`, {});
  ok(r.status === 201 && r.body.status === 'APPROVED', 'HR approves → fully approved', r.body);
  t = (await myReq(pm1.id)).progress;
  ok(t.stage === 'APPROVED' && t.steps.every((s) => s.state === 'done'), 'tracker complete', t);
  r = await call(admin, 'GET', `/leave/ledger?employeeId=${perm.id}&leaveTypeId=${PM.id}`);
  ok(Array.isArray(r.body) && r.body.length === 0, 'hourly leave never touches the ledger', r.body);
  const third = (await call(pooja, 'GET', '/mobile/leave/requests')).body.data.find((x) => x.startDate === NM[2]);
  await call(manager, 'POST', `/mobile/approvals/leave/${third.id}/approve`, {});
  r = await call(admin, 'POST', `/leave/requests/${third.id}/reject`, { note: 'Month-end closing' });
  t = (await myReq(third.id)).progress;
  ok(r.body.status === 'REJECTED' && t.steps[2].state === 'rejected' && t.steps[2].note === 'Month-end closing', 'rejected at HR level with reason shown on the HR step', t);

  r = await call(pooja, 'POST', '/mobile/remote-work', { from: NM[4], to: NM[4], reason: 'site visit' });
  const rw = r.body;
  r = await call(manager, 'POST', `/mobile/approvals/remote/${rw.id}/approve`, {});
  ok(r.status === 201 && r.body.status === 'PENDING' && r.body.managerApproverId, 'remote (org two-level): manager approval passes it to HR', r.body);
  r = await call(pooja, 'GET', '/mobile/remote-work');
  t = r.body.data.find((x) => x.id === rw.id).progress;
  ok(t.levels === 2 && t.stage === 'HR', 'remote tracker: with HR', t);
  r = await call(admin, 'POST', `/remote-work/requests/${rw.id}/reject`, {});
  ok(r.status === 400, 'web reject needs a note too', r.body);
  r = await call(admin, 'POST', `/remote-work/requests/${rw.id}/approve`, {});
  ok(r.body.status === 'APPROVED', 'HR approves remote work', r.body);

  console.log('5. Permission credited on the attendance day');
  r = await call(admin, 'POST', '/punches', { employeeId: perm.id, at: `${YESTERDAY}T11:05:00+05:30`, direction: 'in', reason: 'test' });
  await call(admin, 'POST', '/punches', { employeeId: perm.id, at: `${YESTERDAY}T18:00:00+05:30`, direction: 'out', reason: 'test' });
  const dayOf = async (date) => (await call(admin, 'GET', `/attendance/days?date=${date}&employeeId=${perm.id}`)).body.items?.[0];
  let d = await until(async () => { const x = await dayOf(YESTERDAY); return x?.punchCount === 2 ? x : null; });
  const sunday = new Date(`${YESTERDAY}T00:00:00Z`).getUTCDay() === 0;
  if (sunday) console.log('  (yesterday was a weekly off; skipping lateness checks)');
  else {
    ok(d?.isLate, 'arrived 11:05 → late before permission', d);
    r = await call(admin, 'POST', '/leave/requests', { employeeId: perm.id, leaveTypeId: PM.id, from: YESTERDAY, to: YESTERDAY, startTime: '09:00', endTime: '11:00', reason: 'bank' });
    ok(r.status === 201, 'HR files a 2 h permission for yesterday', r.body);
    await call(admin, 'POST', `/leave/requests/${r.body.id}/approve`, {});
    d = await until(async () => { const x = await dayOf(YESTERDAY); return x?.permissionMinutes === 120 ? x : null; });
    ok(d && !d.isLate && d.lateMinutes === 0 && d.permissionMinutes === 120, 'approved permission: not late, 120 min credited', d);
  }

  console.log('6. Geofence + several sessions a day');
  r = await call(admin, 'PATCH', `/sites/${site.id}`, { name: site.name, timezone: site.timezone, lat: 13.0827, lng: 80.2707, geofenceRadiusM: 200 });
  ok(r.status === 200 && r.body.geofenceRadiusM === 200, 'site geofence: 200 m', r.body);
  r = await call(admin, 'PATCH', `/sites/${site.id}`, { name: site.name, timezone: site.timezone, lat: null, lng: null, geofenceRadiusM: 200 });
  ok(r.status >= 400, 'a radius without a centre is refused', r.body);
  const punch = (direction, lat, lng, extra = {}) => call(pooja, 'POST', '/mobile/punches', { direction, lat, lng, accuracy: 15, selfieBase64: JPEG, ...extra });
  r = await punch('in', 13.0828, 80.2708);
  ok(r.status === 201 && r.body.reviewStatus === 'APPROVED' && /Auto-approved: \d+ m/.test(r.body.reviewNote), 'inside the fence → auto-approved', r.body);
  r = await punch('out', 13.1, 80.27);
  ok(r.status === 201 && r.body.reviewStatus === 'PENDING' && /Outside geofence: \d+ m/.test(r.body.reviewNote), 'outside → waits for a manager', r.body);
  r = await punch('in', 13.0828, 80.2708, { isMockLocation: true });
  ok(r.body.reviewStatus === 'PENDING', 'mock location inside the fence → manual review', r.body);
  r = await call(pooja, 'GET', '/mobile/today');
  ok(r.body.mobilePunch.geofence?.radiusM === 200 && r.body.mobilePunch.nextDirection === 'out', 'today: geofence + next direction (out)', r.body.mobilePunch);
  d = await until(async () => { const x = await dayOf(r.body.day?.workDate ?? TODAY); return x?.punchCount === 3 ? x : null; });
  ok(d && d.segments.length === 2, 'in, out, in → two sessions on the same day', d?.segments);
  await call(admin, 'PATCH', `/sites/${site.id}`, { name: site.name, timezone: site.timezone, lat: 13.0827, lng: 80.2707, geofenceRadiusM: 200, geofenceStrict: true });
  r = await punch('out', 13.1, 80.27);
  ok(r.status === 403 && r.body.code === 'OUTSIDE_GEOFENCE', 'strict site refuses punches outside', r.body);

} catch (err) {
  failures++;
  console.error(err);
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
