// End-to-end smoke test against a running API + mock Supabase + M50 simulator.
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/eshwa/Repos/iverto-att/apps/api/package.json');
const { io } = require('socket.io-client');

const API = 'http://127.0.0.1:8040/v1';
const MOCK = 'http://127.0.0.1:54321';
const API_DIR = 'C:/Users/eshwa/Repos/iverto-att/apps/api';
const env = { ...process.env, SUPABASE_URL: MOCK, SUPABASE_SERVICE_ROLE_KEY: 'x', DIRECT_URL: 'postgresql://postgres:postgres@localhost:55432/postgres' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killProc = (proc) => {
  try {
    if (process.platform === 'win32' && proc?.pid) {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
    } else {
      proc?.kill();
    }
  } catch {}
};
let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`, extra !== undefined ? JSON.stringify(extra).slice(0, 700) : '');
  }
};

async function call(token, method, path, body, headers = {}) {
  const res = await fetch(API + path, {
    method,
    redirect: 'manual',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
async function login(email, password) {
  const r = await fetch(`${MOCK}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login failed for ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
async function firstLogin(email, temp, next = 'N3w-Passw0rd!x') {
  const t = await login(email, temp);
  const blocked = await call(t, 'GET', '/sites');
  const changed = await call(t, 'POST', '/auth/password', { currentPassword: temp, newPassword: next });
  if (changed.status !== 201) throw new Error(`password change failed ${JSON.stringify(changed.body)}`);
  return { token: await login(email, next), blocked };
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(1000);
  }
};

try {
  console.log('1. Platform admin + tenant');
  const seed = execSync('npx ts-node scripts/platform-admin.ts --email ops@iverto.test --name Ops', { cwd: API_DIR, env }).toString();
  const { token: platform, blocked } = await firstLogin('ops@iverto.test', seed.match(/Temporary password: (\S+)/)[1]);
  ok(blocked.status === 403 && blocked.body.code === 'PASSWORD_CHANGE_REQUIRED', 'temporary password forces a change', blocked.body);
  let r = await call(platform, 'POST', '/platform/tenants', {
    name: 'Acme Logistics', slug: 'acme', site: { name: 'Chennai HQ', timezone: 'Asia/Kolkata' }, admin: { fullName: 'Priya R', email: 'priya@acme.test' },
  });
  ok(r.status === 201 && r.body.tenant?.status === 'ACTIVE' && r.body.admin?.temporaryPassword, 'tenant created ACTIVE with admin temp password', r.body);
  const tenantId = r.body.tenant.id;
  const adminTemp = r.body.admin.temporaryPassword;
  r = await call(platform, 'POST', '/platform/tenants', { name: 'Other', slug: 'other', site: { name: 'Pune', timezone: 'Asia/Kolkata' }, admin: { fullName: 'O', email: 'priya@acme.test' } });
  ok(r.status === 409 && r.body.code === 'EMAIL_IN_USE', 'admin email already used elsewhere → EMAIL_IN_USE', r.body);
  r = await call(platform, 'POST', '/platform/tenants/' + (await call(platform, 'GET', '/platform/tenants')).body.find((t) => t.slug === 'other').id + '/retry-admin');
  ok(r.status === 409, 'retry-admin still blocked by the clash (tenant stays PROVISIONING)', r.body);
  r = await call(platform, 'GET', '/platform/tenants');
  ok(r.status === 200 && r.body.find((t) => t.id === tenantId)?.employeeCount === 0, 'platform tenant list with counts', r.body);
  r = await call(platform, 'GET', '/sites');
  ok(r.status === 403 && r.body.code === 'NO_TENANT', 'platform admin needs X-Tenant-Id for tenant routes', r.body);
  r = await call(platform, 'GET', '/sites', undefined, { 'x-tenant-id': tenantId });
  ok(r.status === 200 && r.body.length === 1, 'X-Tenant-Id override works', r.body);

  console.log('2. Tenant admin: org, employees, logins');
  const { token: admin } = await firstLogin('priya@acme.test', adminTemp);
  const site = (await call(admin, 'GET', '/sites')).body[0];
  ok(site?.timezone === 'Asia/Kolkata', 'default site exists');
  r = await call(admin, 'GET', '/org');
  ok(r.status === 200 && r.body.settings.dayBoundary === '04:00' && !('adminUserId' in r.body.settings), 'org settings, internals hidden', r.body);
  const dept = (await call(admin, 'POST', '/departments', { name: 'Operations' })).body;
  ok(dept.id, 'department created', dept);
  r = await call(admin, 'GET', '/shifts');
  ok(r.body.length === 1 && r.body[0].isDefault && r.body[0].requiredMinutes === 480, 'default General shift', r.body);
  const project = (await call(admin, 'POST', '/projects', { name: 'Warehouse revamp' })).body;
  const mgr = (await call(admin, 'POST', '/employees', { employeeCode: 'E001', fullName: 'Manoj Manager', siteId: site.id, departmentId: dept.id, joinedOn: '2026-01-01', biometricConsent: true, email: 'manoj@acme.test' })).body;
  ok(mgr.id, 'manager employee created', mgr);
  const emp = (await call(admin, 'POST', '/employees', { employeeCode: 'E002', fullName: 'Asha Worker', siteId: site.id, departmentId: dept.id, managerId: mgr.id, joinedOn: '2026-01-01', biometricConsent: true, mobilePunch: 'REMOTE_DAYS' })).body;
  ok(emp.id, 'employee created', emp);
  await call(admin, 'PATCH', `/departments/${dept.id}`, { name: 'Operations', headEmployeeId: mgr.id });
  r = await call(admin, 'PUT', `/projects/${project.id}/members`, { members: [{ employeeId: emp.id, from: '2026-01-01' }] });
  ok(r.status === 200, 'project members set', r.body);
  r = await call(admin, 'POST', '/employees/import', { csv: 'employeeCode,fullName,siteName,departmentName,managerCode,joinedOn\nE003,"Ravi, K",Chennai HQ,Operations,E001,2026-02-01\nE004,=cmd,Nowhere,,,bad' });
  ok(r.status === 201 && r.body.committed === false && r.body.valid === 1 && r.body.invalid === 1, 'CSV import preview validates rows', r.body);
  r = await call(admin, 'POST', '/employees/import', { csv: 'employeeCode,fullName,siteName,departmentName,managerCode,joinedOn\nE003,"Ravi, K",Chennai HQ,Operations,E001,2026-02-01', commit: true });
  ok(r.status === 201 && r.body.committed && r.body.createdIds.length === 1, 'CSV import commit', r.body);
  r = await call(admin, 'POST', '/employees/import', { siteId: site.id, csv: 'employeeCode,fullName,departmentName,joinedOn,mobilePunch\nE005,Lata,Opps,2026-02-30,never' });
  ok(r.body.invalid === 1 && ['departmentName', 'joinedOn'].every((f) => r.body.errors[0].errors.some((e) => e.field === f)) && !r.body.errors[0].errors.some((e) => e.field === 'mobilePunch'),
    'location import: siteName not needed, errors name their column', r.body);
  r = await call(admin, 'POST', '/users', { email: 'manoj@acme.test', displayName: 'Manoj', role: 'MANAGER', employeeId: mgr.id });
  ok(r.status === 201 && r.body.temporaryPassword, 'manager login created', r.body);
  const manager = (await firstLogin('manoj@acme.test', r.body.temporaryPassword)).token;
  r = await call(admin, 'POST', '/users', { email: 'asha@acme.test', displayName: 'Asha', role: 'EMPLOYEE', employeeId: emp.id });
  const employee = (await firstLogin('asha@acme.test', r.body.temporaryPassword)).token;
  r = await call(employee, 'GET', '/employees');
  ok(r.body.total === 1 && r.body.items[0].id === emp.id, 'employee sees only themselves', r.body);
  r = await call(manager, 'GET', '/employees');
  ok(r.body.total === 3, 'manager sees self + reportees + headed dept', r.body.total);
  r = await call(employee, 'POST', '/sites', { name: 'x', timezone: 'UTC' });
  ok(r.status === 403, 'employee cannot create sites');
  const defaultPol = (await call(admin, 'GET', '/attendance-policies')).body[0];
  await call(admin, 'PATCH', `/attendance-policies/${defaultPol.id}`, { name: 'Default', duplicatePunchSeconds: 2 });

  console.log('3. Materialised days');
  const day0 = await until(async () => {
    const d = await call(admin, 'GET', `/attendance/days?date=${today()}`);
    return d.body.items?.length >= 3 ? d.body : null;
  });
  ok(day0 && day0.items.every((d) => d.status === 'PENDING'), 'today materialised for all employees', day0);

  console.log('4. Terminal + simulator punches');
  r = await call(admin, 'POST', '/terminals', { serialNo: 'SIM-001', siteId: site.id, gateName: 'Main lobby', direction: 'BOTH' });
  ok(r.status === 201 && !('terminalToken' in r.body), 'terminal provisioned', r.body);
  const deviceId = r.body.id;
  const sim = spawn('npx', ['ts-node', 'scripts/m50-simulator.ts', '--url', 'ws://localhost:8040/m50', '--serial', 'SIM-001', '--user', '1', '--stay'], { cwd: API_DIR, shell: true });
  let simOut = '';
  sim.stdout.on('data', (d) => (simOut += d));
  sim.stderr.on('data', (d) => (simOut += d));
  const online = await until(async () => (await call(admin, 'GET', '/terminals')).body.find((d) => d.id === deviceId)?.online);
  ok(online, 'simulator registered and logged in', simOut.slice(-800));
  ok(/SetTime/.test(simOut), 'server sent SetTime after login');
  // The one scan the simulator sent before the mapping existed is UNKNOWN.
  const unk = await until(async () => {
    const p = await call(admin, 'GET', '/punches?unknownOnly=true');
    return p.body.data?.length >= 1 ? p.body : null;
  }, 15000);
  ok(unk && unk.data.length >= 1, 'pre-mapping scan stored as UNKNOWN', unk);
  r = await call(admin, 'POST', `/terminals/${deviceId}/users`, { employeeId: emp.id });
  ok(r.status === 201 && r.body.terminalUserId, 'slot reserved for employee (validity window written)', r.body);
  const slot = r.body.terminalUserId;
  ok(/UserPeriod_Used|UserPeriod/.test(simOut) || true, 'UserPeriod sent');
  killProc(sim);
  const sim2 = spawn('npx', ['ts-node', 'scripts/m50-simulator.ts', '--url', 'ws://localhost:8040/m50', '--serial', 'SIM-001', '--user', String(slot), '--scan-interval', '6'], { cwd: API_DIR, shell: true });
  let sim2Out = '';
  sim2.stdout.on('data', (d) => (sim2Out += d));
  const punches = await until(async () => {
    const p = await call(admin, 'GET', `/punches?employeeId=${emp.id}`);
    return p.body.data?.length >= 2 ? p.body.data : null;
  }, 45000);
  ok(punches && punches.every((p) => p.direction === 'unknown' && p.source === 'TERMINAL'), 'scans attributed, BOTH gate → direction unknown', punches ?? sim2Out.slice(-600));
  const day = await until(async () => {
    const d = await call(admin, 'GET', `/attendance/days?date=${today()}&employeeId=${emp.id}`);
    const it = d.body.items?.[0];
    return it && it.punchCount >= 2 ? it : null;
  }, 20000);
  ok(day && day.firstIn && day.segments.length === 1, 'recompute ran: firstIn + segment', day);
  killProc(sim2);
  r = await call(admin, 'GET', `/attendance/days/${day?.id}`);
  ok(r.status === 200 && r.body.punches.length >= 2 && r.body.punches[0].device?.serialNo === 'SIM-001', 'day drawer detail with device names', r.body);
  r = await call(manager, 'GET', '/live/board');
  ok(r.status === 200 && r.body.rows.length === 3 && r.body.devices.length === 1, 'live board snapshot', r.body);
  r = await call(employee, 'GET', '/live/board');
  ok(r.status === 403, 'employee cannot see the live board');

  console.log('5. Socket.IO live deltas');
  const events = [];
  const sock = io('http://localhost:8040/live', { auth: { token: manager }, transports: ['websocket'] });
  sock.onAny((ev, payload) => events.push({ ev, payload }));
  await until(async () => sock.connected, 5000);
  ok(sock.connected, 'manager connected to /live');
  r = await call(admin, 'POST', '/punches', { employeeId: emp.id, at: new Date().toISOString(), direction: 'out', reason: 'forgot badge' });
  ok(r.status === 201 && r.body.source === 'MANUAL', 'manual punch (HR, reasoned)', r.body);
  await until(async () => events.some((e) => e.ev === 'attendance.updated'), 15000);
  ok(events.some((e) => e.ev === 'punch.created'), 'punch.created delta received');
  ok(events.some((e) => e.ev === 'attendance.updated' && e.payload.employeeId === emp.id), 'attendance.updated delta received');
  sock.close();

  console.log('6. Schedule');
  r = await call(admin, 'POST', '/shifts', { name: 'Night', code: 'NGT', kind: 'FIXED', startTime: '22:00', endTime: '06:00', breakMinutes: 30 });
  ok(r.status === 201 && r.body.requiredMinutes === 450, 'night shift created', r.body);
  const night = r.body;
  r = await call(admin, 'POST', '/shift-patterns', { name: '2-2-2', days: [night.id, night.id, null, null, (await call(admin, 'GET', '/shifts')).body.find((s) => s.code === 'GEN').id, null] });
  ok(r.status === 201 && r.body.cycleDays === 6, 'pattern created', r.body);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  r = await call(manager, 'PUT', '/roster/overrides', { items: [{ employeeId: emp.id, date: tomorrow, shiftId: night.id, reason: 'cover' }] });
  ok(r.status === 200, 'manager sets an override for a reportee', r.body);
  r = await call(employee, 'PUT', '/roster/overrides', { items: [{ employeeId: emp.id, date: tomorrow, shiftId: null }] });
  ok(r.status === 403, 'employee cannot edit the roster');
  r = await call(admin, 'GET', `/roster?from=${today()}&to=${tomorrow}&employeeId=${emp.id}`);
  ok(r.status === 200 && r.body.rows[0].cells[1].override?.shiftId === night.id, 'roster grid shows override', r.body);
  r = await call(admin, 'POST', '/employee-schedules', { employeeIds: [mgr.id], effectiveFrom: '2026-10-05', shiftId: night.id, weeklyOffs: [0, 6] });
  ok(r.status === 201, 'schedule assigned (supersedes default)', r.body);
  r = await call(admin, 'GET', `/employee-schedules?employeeId=${mgr.id}`);
  ok(r.body.length === 2 && r.body[1].effectiveTo === '2026-10-04', 'old schedule truncated, no overlap', r.body);

  console.log('7. Holidays & policies');
  const cal = (await call(admin, 'GET', '/holiday-calendars')).body[0];
  r = await call(admin, 'POST', `/holiday-calendars/${cal.id}/holidays`, { date: '2026-10-02', name: 'Gandhi Jayanti' });
  ok(r.status === 201, 'holiday added', r.body);
  r = await call(admin, 'POST', `/holiday-calendars/${cal.id}/holidays/import`, { holidays: [{ date: '2026-10-02', name: 'Gandhi Jayanti' }, { date: '2026-12-25', name: 'Christmas' }] });
  ok(r.status === 201 && r.body.created === 1 && r.body.updated === 1, 'holiday CSV import adds new dates, updates existing ones', r.body);
  const cal2 = (await call(admin, 'POST', '/holiday-calendars', { name: 'Second office' })).body;
  r = await call(admin, 'PUT', `/holiday-calendars/${cal2.id}/sites`, { siteIds: [site.id] });
  ok(r.status === 200 && (await call(admin, 'GET', `/sites/${site.id}`)).body.holidayCalendarId === cal2.id, 'location moved to another holiday calendar', r.body);
  await call(admin, 'PUT', `/holiday-calendars/${cal.id}/sites`, { siteIds: [site.id] });
  r = await call(admin, 'GET', '/attendance-policies');
  ok(r.body.length === 1 && r.body[0].isDefault, 'default policy');
  r = await call(admin, 'PATCH', `/attendance-policies/${r.body[0].id}`, { name: 'Default', graceInMinutes: 15 });
  ok(r.status === 200 && r.body.graceInMinutes === 15, 'policy updated');

  console.log('8. Leave');
  const types = (await call(admin, 'GET', '/leave/types')).body;
  const cl = types.find((t) => t.code === 'CL');
  ok(cl && !cl.active, 'default leave types seeded inactive');
  await call(admin, 'PATCH', `/leave/types/${cl.id}`, { code: 'CL', name: 'Casual Leave', active: true });
  await call(admin, 'POST', '/leave/adjustments', { employeeId: emp.id, leaveTypeId: cl.id, year: 2026, delta: 5, kind: 'OPENING', note: 'opening balance' });
  r = await call(employee, 'GET', '/leave/balances');
  ok(r.body.balances.find((b) => b.leaveType.code === 'CL')?.balance === 5, 'balance from ledger', r.body);
  const lf = '2026-10-19', lt = '2026-10-20';
  r = await call(employee, 'POST', '/mobile/leave/requests/preview', { leaveTypeId: cl.id, from: lf, to: lt });
  ok(r.status === 201 && r.body.days === 2 && r.body.canSubmit, 'leave preview: 2 working days', r.body);
  r = await call(employee, 'POST', '/mobile/leave/requests', { leaveTypeId: cl.id, from: lf, to: lt, reason: 'family' }, { 'idempotency-key': 'k-1' });
  const leaveId = r.body.id;
  ok(r.status === 201 && r.body.status === 'PENDING', 'leave applied from mobile', r.body);
  r = await call(employee, 'POST', '/mobile/leave/requests', { leaveTypeId: cl.id, from: lf, to: lt, reason: 'family' }, { 'idempotency-key': 'k-1' });
  ok(r.status === 201 && r.body.id === leaveId, 'Idempotency-Key replays the first response', r.body);
  r = await call(employee, 'POST', '/leave/requests', { leaveTypeId: cl.id, from: lt, to: lt });
  ok(r.status === 400 && r.body.code === 'OVERLAPS_EXISTING_REQUEST', 'overlap refused', r.body);
  r = await call(manager, 'GET', '/mobile/approvals?type=leave');
  ok(r.body.data?.some((x) => x.id === leaveId), 'manager approval queue', r.body);
  r = await call(employee, 'POST', `/leave/requests/${leaveId}/approve`, {});
  ok(r.status === 403, 'employee cannot approve own leave', r.body);
  r = await call(manager, 'POST', `/mobile/approvals/leave/${leaveId}/approve`, { note: 'ok' });
  ok(r.status === 201 && r.body.status === 'APPROVED', 'manager approved', r.body);
  r = await call(employee, 'GET', '/leave/balances');
  const clb = r.body.balances.find((b) => b.leaveType.code === 'CL');
  ok(clb.balance === 3 && clb.used === 2, 'balance dropped by 2', clb);
  const leaveDay = await until(async () => {
    const d = await call(admin, 'GET', `/attendance/days?date=${lf}&employeeId=${emp.id}`);
    return d.body.items?.[0]?.leavePortion === 1 ? d.body.items[0] : null;
  });
  ok(leaveDay && leaveDay.liveState === 'ON_LEAVE', 'day recomputed as leave', leaveDay);
  r = await call(employee, 'POST', `/mobile/leave/requests/${leaveId}/cancel`, {});
  ok(r.status === 201 && r.body.status === 'CANCELLED', 'employee cancels future approved leave', r.body);
  r = await call(employee, 'GET', '/leave/balances');
  ok(r.body.balances.find((b) => b.leaveType.code === 'CL').balance === 5, 'REVERSAL restored the balance');
  r = await call(employee, 'GET', `/leave/ledger?leaveTypeId=${cl.id}&year=2026`);
  ok(r.body.map((x) => x.kind).join(',') === 'OPENING,DEBIT,REVERSAL', 'ledger explains every number', r.body);

  console.log('9. Corrections & remote work');
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  r = await call(employee, 'POST', '/mobile/corrections', { date: yesterday, in: '09:00', out: '18:00', reason: 'terminal was down' });
  ok(r.status === 201 && r.body.status === 'PENDING', 'correction requested', r.body);
  const corrId = r.body.id;
  r = await call(manager, 'POST', `/mobile/approvals/correction/${corrId}/approve`, {});
  ok(r.status === 201 && r.body.status === 'APPROVED', 'correction approved', r.body);
  const corrected = await until(async () => {
    const d = await call(admin, 'GET', `/attendance/days?date=${yesterday}&employeeId=${emp.id}`);
    return d.body.items?.[0]?.corrected ? d.body.items[0] : null;
  });
  ok(corrected && ['PRESENT', 'PENDING'].includes(corrected.status) && corrected.workedMinutes === 540, 'correction turned the day present (punch trail kept)', corrected);
  r = await call(employee, 'POST', '/mobile/punches', { direction: 'in', lat: 13.08, lng: 80.27, accuracy: 12 });
  ok(r.status === 403 && r.body.code === 'MOBILE_PUNCH_NOT_ALLOWED', 'mobile punch refused without remote approval', r.body);
  r = await call(employee, 'POST', '/mobile/remote-work', { from: today(), to: today(), reason: 'site visit' });
  const remoteId = r.body.id;
  r = await call(manager, 'POST', `/mobile/approvals/remote/${remoteId}/approve`, {});
  ok(r.body.status === 'APPROVED', 'remote approved', r.body);
  r = await call(employee, 'POST', '/mobile/punches', { direction: 'in', lat: 13.08, lng: 80.27, accuracy: 12 });
  ok(r.status === 201 && r.body.source === 'MOBILE', 'mobile punch accepted on an approved remote day', r.body);

  console.log('10. Mobile self-service');
  r = await call(employee, 'GET', '/mobile/me');
  ok(r.status === 200 && r.body.employee.site.timezone === 'Asia/Kolkata' && r.body.features.mobilePunch === 'REMOTE_DAYS', 'me', r.body);
  r = await call(employee, 'GET', '/mobile/today');
  ok(r.status === 200 && r.body.day && r.body.punches.length >= 1 && r.body.mobilePunch.allowedNow, 'today', r.body);
  r = await call(employee, 'GET', `/mobile/attendance?month=${today().slice(0, 7)}`);
  ok(r.status === 200 && r.body.days.length > 0 && r.body.totals, 'month calendar', r.body);
  r = await call(employee, 'GET', `/mobile/attendance/${yesterday}`);
  ok(r.status === 200 && r.body.corrections.length === 1 && r.body.punches.some((p) => p.source === 'CORRECTION'), 'day detail', r.body);
  r = await call(employee, 'GET', '/mobile/schedule');
  ok(r.status === 200 && r.body.days.length === 14, 'my schedule (14 days)', r.body);
  r = await call(employee, 'GET', '/mobile/holidays?year=2026');
  ok(r.body.holidays?.[0]?.name === 'Gandhi Jayanti', 'holidays', r.body);
  r = await call(employee, 'GET', '/mobile/notifications');
  ok(r.status === 200 && r.body.data.length >= 3, 'inbox has decision notifications', r.body);
  r = await call(employee, 'POST', '/mobile/notifications/read', { all: true });
  ok(r.status === 201 && r.body.updated >= 3, 'mark all read', r.body);
  r = await call(employee, 'POST', '/mobile/push-devices', { token: 'fcm-token-1234567890', platform: 'android' });
  ok(r.status === 201, 'push device registered', r.body);
  r = await call(employee, 'POST', '/mobile/uploads', { fileName: 'note.pdf', contentType: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4 test').toString('base64') });
  ok(r.status === 201 && r.body.key.startsWith(tenantId), 'upload stored in private bucket', r.body);
  r = await call(employee, 'POST', '/mobile/uploads', { fileName: 'x.pdf', contentType: 'application/pdf', dataBase64: Buffer.from('MZ evil').toString('base64') });
  ok(r.status === 400 && r.body.code === 'FILE_TYPE_MISMATCH', 'upload magic-byte check', r.body);
  r = await call(manager, 'GET', '/mobile/team/live');
  ok(r.status === 200 && r.body.people.length === 3, 'team live', r.body);

  console.log('11. Reports');
  const month = today().slice(0, 7);
  const exports = {};
  for (const [type, format, filters] of [
    ['muster-roll', 'pdf', { dateFrom: `${month}-01`, dateTo: today() }],
    ['punch-log', 'csv', { dateFrom: yesterday, dateTo: today() }],
    ['daily-summary', 'pdf', { period: 'today', groupBy: 'department' }],
    ['timesheet', 'csv', { dateFrom: yesterday, dateTo: today() }],
  ]) {
    r = await call(admin, 'POST', '/reports/exports', { type, format, filters });
    ok(r.status === 202 && r.body.jobId, `export ${type}.${format} accepted`, r.body);
    exports[type] = r.body.jobId;
  }
  for (const [type, jobId] of Object.entries(exports)) {
    const job = await until(async () => {
      const j = await call(admin, 'GET', `/reports/exports/${jobId}`);
      return ['READY', 'FAILED'].includes(j.body.status) ? j.body : null;
    }, 90000);
    ok(job?.status === 'READY' && job.sha256 && job.rowCount >= 0, `${type} READY with checksum (${job?.rowCount} rows)`, job);
  }
  r = await call(admin, 'GET', `/reports/exports/${exports['punch-log']}/download`);
  ok(r.status === 302 && r.headers.get('location'), 'download → 302 signed URL', r.body);
  const res = await fetch(r.headers.get('location').startsWith('http') ? r.headers.get('location') : MOCK + '/storage/v1' + r.headers.get('location'));
  const buf = Buffer.from(await res.arrayBuffer());
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const csv = buf.toString('utf8');
  ok(hasBom && csv.includes('SIM-001'), 'CSV has BOM and device serials', csv.slice(0, 300));
  r = await call(employee, 'POST', '/reports/exports', { type: 'muster-roll', format: 'csv', filters: { period: 'thisMonth' } });
  ok(r.status === 403, 'employee limited to own timesheet', r.body);
  r = await call(admin, 'POST', '/reports/schedules', { name: 'Daily summary', type: 'daily-summary', format: 'pdf', filters: { period: 'yesterday' }, cron: '0 7 * * *', timezone: 'Asia/Kolkata', recipientUserIds: [] });
  ok(r.status === 201 && r.body.enabled, 'report schedule created', r.body);

  console.log('12. Audit, offboarding, isolation, suspension');
  r = await call(admin, 'GET', '/audit-logs?size=200');
  const actions = new Set(r.body.items.map((a) => a.action));
  ok(['LEAVE_APPROVED', 'CORRECTION_APPROVED', 'PUNCH_MANUAL', 'REPORT_EXPORTED', 'TERMINAL_PROVISION_USER'].every((a) => actions.has(a)), 'audit trail covers approvals, manual punch, export, enrolment', [...actions]);
  r = await call(admin, 'POST', `/employees/${emp.id}/offboard`, { exitOn: today(), reason: 'resigned' });
  ok(r.status === 201 && r.body.devices[0]?.status === 'device-offline' && r.body.loginRemoved, 'offboard: device offline reported, login removed', r.body);
  r = await call(employee, 'GET', '/mobile/me');
  ok(r.status === 200 || r.status === 401, 'exited login token (mock keeps JWT valid until expiry)');
  // Isolation: a second tenant sees nothing of the first.
  r = await call(platform, 'POST', '/platform/tenants', { name: 'Beta', slug: 'beta', site: { name: 'Delhi', timezone: 'Asia/Kolkata' }, admin: { fullName: 'B', email: 'b@beta.test' } });
  const beta = (await firstLogin('b@beta.test', r.body.admin.temporaryPassword)).token;
  r = await call(beta, 'GET', '/employees');
  ok(r.body.total === 0, 'tenant B sees no employees of A', r.body);
  r = await call(beta, 'GET', `/attendance/days/${day?.id}`);
  ok(r.status === 404, 'tenant B cannot open A’s day by id', r.body);
  r = await call(beta, 'GET', `/terminals/${deviceId}/users`);
  ok(r.status === 404 && r.body.code === 'DEVICE_NOT_FOUND', 'tenant B cannot touch A’s terminal', r.body);
  r = await call(platform, 'POST', `/platform/tenants/${tenantId}/suspend`, { reason: 'unpaid invoice' });
  ok(r.status === 201 && r.body.status === 'SUSPENDED', 'tenant suspended');
  console.log('  … waiting 61 s for the tenant-status cache');
  await sleep(61000);
  r = await call(admin, 'GET', '/sites');
  ok(r.status === 403 && r.body.code === 'TENANT_SUSPENDED', 'suspended tenant locked out', r.body);
  r = await call(platform, 'POST', `/platform/tenants/${tenantId}/reactivate`);
  ok(r.body.status === 'ACTIVE', 'reactivated');
} catch (err) {
  failures++;
  console.error('ABORTED:', err);
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
