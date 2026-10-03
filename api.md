# Iverto Attendance API Reference (Web, Admin & Platform)

Comprehensive technical documentation for the Iverto Attendance backend web and administrative endpoints (`/v1/*`).

---

## 1. Architectural Overview & Conventions

### Base URL
- **Production Proxy Base**: `https://<api-domain>/att/v1` (Proxy strips `/att` and routes to API)
- **Direct Service Base**: `http://<host>:8040/v1`
- **Swagger OpenAPI Docs**: `/docs` (JSON available at `/docs/openapi.json` in non-production)

### Authentication
All endpoints (except `/v1/health/*` and terminal WebSocket handshakes) require an `Authorization` header containing a valid Supabase JWT Bearer token:
```http
Authorization: Bearer <access_token>
```
Tokens are verified against the Supabase project JWKS endpoint using asymmetric keys (RS256/ES256).

#### User Context Claims (`app_metadata`)
The JWT claims are decoded and enforced across all domain modules:
- `sub`: Unique user ID (Supabase Auth UID).
- `tenant_id`: Associated tenant UUID. Required for all tenant-scoped operations.
- `role`: One of `ADMIN`, `HR`, `MANAGER`, `EMPLOYEE`, or `PLATFORM_ADMIN` (for super admins).
- `employee_id`: Linked employee UUID (if assigned).
- `site_ids`: Array of site UUIDs restricted to the user (empty array grants all tenant sites).
- `must_change_password`: Boolean indicating temporary credentials requiring replacement before standard access.

#### Platform Admin Impersonation
Users with `is_super_admin: true` in their token can troubleshoot and manage any tenant by passing the `X-Tenant-Id` header:
```http
X-Tenant-Id: <tenant-uuid>
```
When this header is passed, the platform admin acts with `ADMIN` role inside that tenant, and an audit entry (`PLATFORM_TENANT_OVERRIDE`) is logged.

### Standard Response & Error Format
All errors thrown by the application follow the standardized RFC-compliant error schema:

```json
{
  "statusCode": 400,
  "code": "BAD_REQUEST",
  "message": "Human-readable explanation of error",
  "details": []
}
```

#### Common Machine-Readable Codes
| HTTP Status | Error Code | Description |
|---|---|---|
| `400` | `VALIDATION_FAILED` | Class-validator payload violation. `details` contains field failure messages. |
| `400` | `CONSTRAINT_FAILED` | Database integrity constraint failed. |
| `400` | `INVALID_REFERENCE`| Foreign key reference does not exist. |
| `401` | `UNAUTHORIZED` | Missing, expired, or malformed Bearer token. |
| `403` | `FORBIDDEN` | Caller lacks the role or permission required for the operation. |
| `403` | `TENANT_SUSPENDED`| The tenant is deactivated. User login blocked until reactivation. |
| `403` | `PASSWORD_CHANGE_REQUIRED` | Initial temporary password must be replaced via `/v1/auth/password`. |
| `404` | `NOT_FOUND` | Requested entity does not exist. |
| `409` | `DUPLICATE` / `CONFLICT` | Unique key collision (e.g. employee code, tenant slug). |
| `409` | `OVERLAP` | Date range conflict with an existing schedule or leave record. |
| `413` | `PAYLOAD_TOO_LARGE`| Payload exceeded maximum body threshold (10MB HTTP max, 5MB file upload max). |
| `429` | `TOO_MANY_REQUESTS`| Exceeded rate limiter window (600/min standard, 10/min password change). |
| `503` | `NOT_READY` / `SERVICE_UNAVAILABLE` | Database, Redis, or hardware gateway connection failure. |

---

## 2. Platform Administration (`/v1/platform/tenants`)

> **Access Control**: Super Admins (`PLATFORM_ADMIN`) only.

### 2.1 List All Tenants
```http
GET /v1/platform/tenants
```
Retrieves all onboarded organisations with real-time operational metrics.

#### Response `200 OK`
```json
[
  {
    "id": "18f97e23-74cf-4ca6-b8f2-d853e3d98c11",
    "name": "Acme Manufacturing",
    "slug": "acme-mfg",
    "status": "ACTIVE",
    "createdAt": "2026-03-15T08:00:00.000Z",
    "suspendedAt": null,
    "suspendedReason": null,
    "employeeCount": 240,
    "terminalCount": 6,
    "terminalsOnline": 5,
    "lastPunchAt": "2026-03-30T09:42:15.000Z"
  }
]
```

---

### 2.2 Create & Provision Tenant
```http
POST /v1/platform/tenants
```
Initializes a new isolated tenant along with its initial site, holiday calendar, default attendance policy, standard shift, leave types, and administrator account.

#### Request Body
```json
{
  "name": "Acme Manufacturing",
  "slug": "acme-mfg",
  "site": {
    "name": "Main Plant",
    "timezone": "Asia/Kolkata"
  },
  "admin": {
    "fullName": "Jane Doe",
    "email": "jane.doe@acme.com"
  }
}
```

#### Response `201 Created`
```json
{
  "tenant": {
    "id": "18f97e23-74cf-4ca6-b8f2-d853e3d98c11",
    "name": "Acme Manufacturing",
    "slug": "acme-mfg",
    "status": "ACTIVE",
    "createdAt": "2026-03-30T10:00:00.000Z"
  },
  "admin": {
    "userId": "92f1b8a5-d0c3-4d7a-8fbe-449e7b231122",
    "email": "jane.doe@acme.com",
    "temporaryPassword": "Init-7k9!bX2@vL"
  }
}
```

---

### 2.3 Get Tenant Details & Audit History
```http
GET /v1/platform/tenants/:id
```
Returns comprehensive metadata for a specific tenant including all sites and administrative audit events.

---

### 2.4 Update Tenant Details
```http
PATCH /v1/platform/tenants/:id
```
#### Request Body
```json
{
  "name": "Acme Industries Global",
  "slug": "acme-global"
}
```

---

### 2.5 Suspend Tenant
```http
POST /v1/platform/tenants/:id/suspend
```
Suspends the organisation. Active users are blocked from access within 60 seconds (cached TTL). Terminals are rejected upon connection/login and will buffer punches locally.

#### Request Body
```json
{
  "reason": "Non-payment of subscription fees"
}
```

---

### 2.6 Reactivate Tenant
```http
POST /v1/platform/tenants/:id/reactivate
```
Restores tenant status to `ACTIVE`.

---

### 2.7 Retry Tenant Provisioning
```http
POST /v1/platform/tenants/:id/retry-admin
```
Used if administrator creation failed during asynchronous provisioning. Completes pending admin registration.

---

### 2.8 Reset Tenant Admin Password
```http
POST /v1/platform/tenants/:id/admin/reset-password
```
Generates a new temporary password for the initial tenant administrator and flags `mustChangePassword = true`.

#### Response `200 OK`
```json
{
  "userId": "92f1b8a5-d0c3-4d7a-8fbe-449e7b231122",
  "email": "jane.doe@acme.com",
  "temporaryPassword": "Temp-9uP#1aQ8*zR"
}
```

---

## 3. Authentication & User Management

### 3.1 Change Own Password
```http
POST /v1/auth/password
```
> **Access Control**: Any authenticated user (including users with `mustChangePassword = true`). Rate-limited to 10 attempts/minute.

#### Request Body
```json
{
  "currentPassword": "Temp-9uP#1aQ8*zR",
  "newPassword": "SecurePersonalPassword2026!"
}
```

#### Response `200 OK`
```json
{
  "status": "ok",
  "message": "Password updated successfully"
}
```

---

### 3.2 List Tenant Users
```http
GET /v1/users
```
> **Access Control**: `ADMIN`, `HR`.

Returns all web and mobile logins configured for the tenant.

#### Response `200 OK`
```json
[
  {
    "userId": "92f1b8a5-d0c3-4d7a-8fbe-449e7b231122",
    "email": "jane.doe@acme.com",
    "displayName": "Jane Doe",
    "role": "ADMIN",
    "status": "ACTIVE",
    "employeeId": null,
    "siteIds": [],
    "mustChangePassword": false,
    "createdAt": "2026-03-30T10:00:00.000Z"
  }
]
```

---

### 3.3 Create User Account
```http
POST /v1/users
```
> **Access Control**: `ADMIN` (all roles), `HR` (`EMPLOYEE` and `MANAGER` roles only).

#### Request Body
```json
{
  "email": "mark.lead@acme.com",
  "displayName": "Mark Lead",
  "role": "MANAGER",
  "employeeId": "2bf51cc7-2287-4d92-95f7-920f92b02441",
  "siteIds": ["05d53cb1-efec-4be8-8422-44673891d4e0"]
}
```

#### Response `201 Created`
```json
{
  "userId": "d742aa15-8889-4a99-b1d6-4e55e81878a2",
  "email": "mark.lead@acme.com",
  "temporaryPassword": "Gen-4xW#9kL1!aP"
}
```

---

### 3.4 Update User
```http
PATCH /v1/users/:id
```
> **Access Control**: `ADMIN`.

#### Request Body
```json
{
  "displayName": "Mark Lead Jr.",
  "role": "HR",
  "siteIds": []
}
```

---

### 3.5 Deactivate User
```http
DELETE /v1/users/:id
```
> **Access Control**: `ADMIN`. Revokes active sessions in Supabase Auth and marks status as `INACTIVE`.

---

### 3.6 Reactivate User
```http
POST /v1/users/:id/reactivate
```
> **Access Control**: `ADMIN`. Re-enables the user account.

---

### 3.7 Reset User Password
```http
POST /v1/users/:id/reset-password
```
> **Access Control**: `ADMIN`, `HR`. Generates a new temporary password.

---

## 4. Organization Structure (`/v1/org`, `/v1/sites`, `/v1/departments`, `/v1/projects`)

### 4.1 Organization Settings
```http
GET /v1/org
PATCH /v1/org
```
- `GET`: Returns company name, slug, day boundary cutoff (`dayBoundary`, e.g. `04:00`), default weekly off days (e.g. `[0]` for Sunday), branding configuration, and retention limits.
- `PATCH`: Modifies settings (`ADMIN` only). Modifying `dayBoundary` automatically queues attendance recalculation for `[today - 1, today + 14]` across the tenant.

#### Request Body (`PATCH /v1/org`)
```json
{
  "name": "Acme Manufacturing Ltd",
  "dayBoundary": "05:00",
  "defaultWeeklyOffs": [0, 6],
  "storePunchPhotos": true,
  "punchPhotoRetentionDays": 90,
  "reportRetentionDays": 365,
  "branding": {
    "logoUrl": "https://assets.acme.com/branding/logo.png",
    "primaryColor": "#1E40AF",
    "displayName": "Acme Workforce"
  }
}
```

---

### 4.2 Sites (`/v1/sites`)
Sites define physical workplace boundaries and legal timezone contexts.
- `GET /v1/sites`: List tenant sites.
- `POST /v1/sites`: Create a site (`ADMIN` only).
- `GET /v1/sites/:id`: Get site details.
- `PATCH /v1/sites/:id`: Update site (`ADMIN` only).
- `DELETE /v1/sites/:id`: Delete site (`ADMIN` only; fails with `409 SITE_IN_USE` if employees or terminals are assigned).

#### Site Creation Payload
```json
{
  "name": "Pune Tech Park",
  "address": "Tower 4, Magarpatta City, Pune",
  "timezone": "Asia/Kolkata",
  "holidayCalendarId": "9d150244-a0c3-42e1-a20c-c69812a688b1"
}
```

---

### 4.3 Departments (`/v1/departments`)
- `GET /v1/departments`: List departments with employee headcount.
- `POST /v1/departments`: Create department (`ADMIN`, `HR`).
- `PATCH /v1/departments/:id`: Update department (`ADMIN`, `HR`).
- `DELETE /v1/departments/:id`: Remove department (`ADMIN`, `HR`; rejected if employees exist).

#### Department Payload
```json
{
  "name": "Quality Engineering",
  "code": "QE",
  "headEmployeeId": "2bf51cc7-2287-4d92-95f7-920f92b02441",
  "policyId": "d32782b1-0ea9-42b7-8378-43d7890ecb12"
}
```

---

### 4.4 Projects & Project Membership (`/v1/projects`)
Cross-departmental temporary groupings.
- `GET /v1/projects`: List projects.
- `POST /v1/projects`: Create project.
- `PATCH /v1/projects/:id`: Update project.
- `DELETE /v1/projects/:id`: Remove project.
- `GET /v1/projects/:id/members`: List active and historical employee memberships with `from` and `to` dates.
- `PUT /v1/projects/:id/members`: Atomic replacement of project membership roster (`ADMIN`, `HR`).

#### Members Allocation Payload (`PUT /v1/projects/:id/members`)
```json
{
  "members": [
    {
      "employeeId": "2bf51cc7-2287-4d92-95f7-920f92b02441",
      "from": "2026-04-01",
      "to": "2026-09-30"
    }
  ]
}
```

---

## 5. Employee Master & Offboarding (`/v1/employees`)

> **Access Control**: `ADMIN`, `HR` for mutations; scoped reads for `MANAGER`.

### 5.1 Query Employees
```http
GET /v1/employees?siteId=&departmentId=&projectId=&managerId=&status=ACTIVE&q=&page=1&size=50
```
#### Query Parameters
- `siteId`, `departmentId`, `projectId`, `managerId`: Filter by organizational relationships.
- `status`: `ACTIVE` (default) or `EXITED`.
- `q`: Partial substring match on name, employee code, or email.
- `page`, `size`: Pagination parameters (default size 50, max 500).

---

### 5.2 Create Employee
```http
POST /v1/employees
```
Creates an employee, establishes their initial schedule (default shift or specified `shiftId`), and initiates materialized attendance days.

#### Request Body
```json
{
  "employeeCode": "EMP-0412",
  "fullName": "Rahul Sharma",
  "siteId": "05d53cb1-efec-4be8-8422-44673891d4e0",
  "departmentId": "c3562309-842b-45a8-b642-c6cb0e9f1604",
  "managerId": "2bf51cc7-2287-4d92-95f7-920f92b02441",
  "email": "rahul.sharma@acme.com",
  "phone": "+919876543210",
  "designation": "Production Specialist",
  "employmentType": "FULL_TIME",
  "joinedOn": "2026-04-01",
  "mobilePunch": "REMOTE_DAYS",
  "biometricConsent": true,
  "shiftId": "e2bb33f5-1952-443b-a13f-2d7c588e390c"
}
```

---

### 5.3 Bulk CSV Import
```http
POST /v1/employees/import
```
Processes an RFC 4180 CSV file (max 5000 rows). Can run in dry-run mode (`commit: false`) to validate relations, headers, and uniqueness before applying.

#### CSV Header Format
```csv
employeeCode,fullName,siteName,departmentName,managerCode,email,phone,designation,employmentType,joinedOn,mobilePunch
```
Pass `siteId` to import a whole file into one location; `siteName` is then not needed. `joinedOn` must be a real `YYYY-MM-DD` date; `mobilePunch` and `employmentType` are case-insensitive.

Dry-run errors name the column at fault, so a client can highlight the cell:
```json
{ "committed": false, "total": 2, "valid": 1, "invalid": 1,
  "errors": [{ "line": 3, "errors": [{ "field": "departmentName", "message": "unknown department \"Opps\"" }] }] }
```

#### Request Body
```json
{
  "csv": "employeeCode,fullName,siteName,departmentName,managerCode,email,phone,designation,joinedOn,mobilePunch\nEMP-101,John Smith,Main Plant,Quality Control,,john@acme.com,,Inspector,2026-04-01,NEVER",
  "commit": true,
  "biometricConsent": true
}
```

#### Response `200 OK`
```json
{
  "committed": true,
  "total": 1,
  "valid": 1,
  "invalid": 0,
  "errors": [],
  "createdIds": ["88cfc843-e6ef-4613-8991-ecff02a9e334"]
}
```

---

### 5.4 Get Employee Profile
```http
GET /v1/employees/:id
```
Returns employee record, active system login account status, recent work schedules, terminal slot bindings, and face template synchronization state.

---

### 5.5 Update Employee
```http
PATCH /v1/employees/:id
```
Updates employee data. Changing `joinedOn` or `exitOn` triggers automated validity period synchronization across all physical terminals holding the employee's face slot.

---

### 5.6 Employee Offboarding (Exit Management)
```http
POST /v1/employees/:id/offboard
```
Atomic execution of employee exit workflow:
1. Deletes future materialized attendance days past `exitOn`.
2. Cancels pending leave and remote work requests.
3. Deletes biometric face templates from database.
4. Commands all active terminals holding employee slots to release the slot and delete hardware face records.
5. Deletes active Supabase Auth user credentials (freeing the email address).
6. Sets employee status to `EXITED`.

#### Request Body
```json
{
  "exitOn": "2026-04-30",
  "reason": "Resigned to pursue higher education"
}
```

#### Response `200 OK`
```json
{
  "employee": {
    "id": "88cfc843-e6ef-4613-8991-ecff02a9e334",
    "status": "EXITED",
    "exitOn": "2026-04-30"
  },
  "devices": [
    {
      "deviceId": "dev-01",
      "serialNo": "DJ20250307014",
      "status": "cleared"
    }
  ],
  "loginRemoved": true
}
```

---

## 6. Terminals & M50 Biometrics (`/v1/terminals`)

Control plane for M50 facial recognition terminals communicating over persistent raw WebSocket connections.

### 6.1 Fleet Overview
```http
GET /v1/terminals
```
Lists registered devices with real-time socket connection status, IP addresses, enrolled slot counts, and unattributed punch queues.

#### Response `200 OK`
```json
[
  {
    "id": "78b77622-cce7-4fe7-b769-d419bdfca512",
    "serialNo": "DJ20250307014",
    "name": "North Gate Turnstile",
    "gateName": "North Gate",
    "direction": "IN",
    "siteId": "05d53cb1-efec-4be8-8422-44673891d4e0",
    "siteName": "Main Plant",
    "status": "online",
    "lastSeenAt": "2026-03-30T10:14:22.000Z",
    "ipAddress": "192.168.1.120",
    "activeSlots": 142,
    "unattributedPunches": 3
  }
]
```

---

### 6.2 Provision Terminal
```http
POST /v1/terminals
```
Authorizes a terminal by its factory serial number prior to initial network connection.

#### Request Body
```json
{
  "serialNo": "DJ20250307014",
  "siteId": "05d53cb1-efec-4be8-8422-44673891d4e0",
  "name": "North Gate Turnstile",
  "gateName": "North Gate",
  "direction": "BOTH",
  "clockTimezone": "Asia/Kolkata"
}
```

---

### 6.3 Template Coverage & Management
- `GET /v1/terminals/templates/coverage`: Matrix showing which employees have active templates and which terminals have received them.
- `POST /v1/terminals/templates/capture`: Harvests face biometric templates from a source terminal for an array of employee IDs.
- `POST /v1/terminals/templates/distribute`: Pushes stored templates to multiple destination terminals.

#### Distribute Request Body
```json
{
  "employeeIds": ["88cfc843-e6ef-4613-8991-ecff02a9e334"],
  "deviceIds": ["dev-02", "dev-03"],
  "sourceDeviceId": "dev-01",
  "skipEnrolled": true
}
```

---

### 6.4 Slot Reservation & Keypad Claim Workflow
1. **Pre-reserve Slot**:
   ```http
   POST /v1/terminals/:deviceId/users
   ```
   ```json
   { "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334" }
   ```
   Allocates a unique numerical hardware `UserID` (slot) on the terminal and configures employee validity dates.

2. **Claim Keypad Enrolment**:
   If an employee enrolled at the physical terminal keypad without pre-reservation, link the slot:
   ```http
   POST /v1/terminals/:deviceId/users/:terminalUserId/claim
   ```
   ```json
   {
     "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
     "renameOnDevice": true,
     "captureTemplate": true
   }
   ```
   Attributed retroactively to any previously recorded `UNKNOWN` punches originating from this slot.

3. **Release Claim**:
   ```http
   DELETE /v1/terminals/:deviceId/users/:terminalUserId/claim
   ```

---

### 6.5 Direct Face Enrolment via Photo
```http
POST /v1/terminals/:deviceId/enroll/photo
```
Uploads a base64-encoded JPEG (<32KB decoded) directly to the terminal's neural model for zero-touch enrollment.

```json
{
  "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
  "photoBase64": "/9j/4AAQSkZJRgABAQEASABIAAD..."
}
```

---

### 6.6 Hardware Inspection & Diagnostics
- `GET /v1/terminals/:deviceId/device/status`: Real-time hardware health (CPU, memory, storage, temperature).
- `GET /v1/terminals/:deviceId/device/logs?from=0&limit=100`: Hardware punch buffer stored on device Flash.
- `GET /v1/terminals/:deviceId/device/users`: Compares physical hardware slots with local database mappings.
- `GET /v1/terminals/:deviceId/device/users/:terminalUserId/photo`: Retrieves facial capture JPEG snapshot stored in terminal RAM.
- `GET /v1/terminals/:deviceId/device/unclaimed`: Lists all slots occupied on hardware not bound to an employee.
- `GET /v1/terminals/:deviceId/device/admin-logs`: Terminal system audit logs (categories: `enrollment`, `deletion`, `configuration`, `session`).

---

## 7. Punches & Attendance Records (`/v1/punches`)

### 7.1 List Raw Punches
```http
GET /v1/punches?from=2026-03-01&to=2026-03-30&siteId=&employeeId=&source=TERMINAL&unknownOnly=false&cursor=&limit=100
```
Cursor-paginated immutable raw punch log sorted descending by timestamp.

#### Response `200 OK`
```json
{
  "data": [
    {
      "id": "punch-01",
      "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
      "employeeName": "Rahul Sharma",
      "employeeCode": "EMP-0412",
      "punchedAt": "2026-03-30T09:02:14.000Z",
      "localTime": "2026-03-30 14:32:14",
      "workDate": "2026-03-30",
      "direction": "in",
      "source": "TERMINAL",
      "deviceId": "dev-01",
      "deviceName": "North Gate Turnstile",
      "siteId": "05d53cb1-efec-4be8-8422-44673891d4e0"
    }
  ],
  "nextCursor": "eyJ0IjoiMjAyNi0wMy0zMFQwOTowMjoxNC4wMDBaIiwiaWQiOiJwdW5jaC0wMSJ9"
}
```

---

### 7.2 Manual HR Punch Insertion
```http
POST /v1/punches
```
> **Access Control**: `ADMIN`, `HR`. Inserts an audited punch entry directly and queues immediate recomputation.

```json
{
  "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
  "at": "2026-03-30T09:05:00.000Z",
  "direction": "in",
  "reason": "Biometric device offline during power cut"
}
```

---

## 8. Shifts & Roster Scheduling (`/v1/shifts`, `/v1/shift-patterns`, `/v1/roster`)

### 8.1 Shift Definitions (`/v1/shifts`)
- `GET /v1/shifts`: List defined shifts.
- `POST /v1/shifts`: Create shift (`ADMIN`, `HR`).
- `PATCH /v1/shifts/:id`: Update shift properties.
- `DELETE /v1/shifts/:id`: Deactivate shift.

#### Shift Payload
```json
{
  "name": "General Day Shift",
  "code": "GEN",
  "color": "#10B981",
  "kind": "FIXED",
  "startTime": "09:00",
  "endTime": "18:00",
  "breakMinutes": 60,
  "requiredMinutes": 480,
  "coreStart": null,
  "coreEnd": null,
  "worksHolidays": false,
  "isDefault": true,
  "active": true
}
```

---

### 8.2 Shift Rotation Patterns (`/v1/shift-patterns`)
Rotational repeating cyclical patterns (e.g. 6 days Morning, 2 days Off).
- `GET /v1/shift-patterns`: List patterns.
- `POST /v1/shift-patterns`: Create pattern (`ADMIN`, `HR`).
- `PATCH /v1/shift-patterns/:id`: Update pattern.
- `DELETE /v1/shift-patterns/:id`: Delete pattern (rejected if assigned to employees).

#### Pattern Payload
```json
{
  "name": "Morning-Night-Off Cycle",
  "days": [
    "shift-id-morning",
    "shift-id-morning",
    "shift-id-night",
    "shift-id-night",
    null,
    null
  ]
}
```

---

### 8.3 Employee Schedule Assignment (`/v1/employee-schedules`)
Assigns fixed shifts or rotating patterns to employees starting from an effective date.

```http
POST /v1/employee-schedules
```
```json
{
  "employeeIds": ["88cfc843-e6ef-4613-8991-ecff02a9e334"],
  "effectiveFrom": "2026-04-01",
  "effectiveTo": "2026-12-31",
  "shiftId": "e2bb33f5-1952-443b-a13f-2d7c588e390c",
  "weeklyOffs": [0, 6],
  "reevaluateHistory": false
}
```

---

### 8.4 Roster Grid & Conflict Validation (`/v1/roster`)
```http
GET /v1/roster?from=2026-04-01&to=2026-04-14&departmentId=
```
Evaluates shift assignments against legal and company health policies. Automatically tags conflicts:
- `REST_TOO_SHORT`: Less than policy minimum rest hours between consecutive shifts.
- `LEAVE_OVERLAP`: Employee has approved leave on a scheduled working day.
- `WEEKLY_HOURS_EXCEEDED`: Exceeds policy maximum weekly hours.

---

### 8.5 Manager Roster Overrides (`/v1/roster/overrides`)
- `PUT /v1/roster/overrides`: Upsert temporary shift replacements or assign ad-hoc rest days.
- `DELETE /v1/roster/overrides`: Revert overrides to underlying master schedule.

#### Upsert Overrides Payload
```json
{
  "items": [
    {
      "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
      "date": "2026-04-05",
      "shiftId": null,
      "reason": "Compensatory rest day"
    }
  ],
  "reevaluateHistory": true
}
```

---

## 9. Holiday Calendars & Attendance Policies

### 9.1 Holiday Calendars (`/v1/holiday-calendars`)
- `GET /v1/holiday-calendars`: List calendars.
- `POST /v1/holiday-calendars`: Create calendar.
- `GET /v1/holiday-calendars/:id/holidays`: List specific holidays.
- `POST /v1/holiday-calendars/:id/holidays`: Add holiday date (triggers automatic recalculation of affected site employee schedules).
- `DELETE /v1/holiday-calendars/:id/holidays/:holidayId`: Remove holiday.
- `POST /v1/holiday-calendars/:id/holidays/import`: Bulk add `{ "holidays": [{ "date": "2027-01-26", "name": "Republic Day" }] }` (max 1000). A date already in the calendar takes the new name. Returns `{ imported, created, updated }`.
- `PUT /v1/holiday-calendars/:id/sites`: Set which office locations follow this calendar, `{ "siteIds": [...] }`. Listed sites move here; sites dropped from the list are left without a calendar. Affected employees' days (yesterday → +14 days) are recomputed, as they are when `PATCH /v1/sites/:id` changes `holidayCalendarId`.

#### Add Holiday Payload
```json
{
  "date": "2026-05-01",
  "name": "Labor Day"
}
```

---

### 9.2 Attendance Policies (`/v1/attendance-policies`)
Defines the parameters used by the automated attendance compute engine.

```http
POST /v1/attendance-policies
PATCH /v1/attendance-policies/:id
```
#### Policy Parameters Payload
```json
{
  "name": "Standard Corporate Policy",
  "isDefault": true,
  "graceInMinutes": 15,
  "graceOutMinutes": 10,
  "halfDayMinPercent": 50,
  "fullDayMinPercent": 85,
  "earlyWindowMinutes": 120,
  "lateWindowMinutes": 240,
  "duplicatePunchSeconds": 60,
  "minSessionMinutes": 15,
  "absentAfterMinutes": 240,
  "missedOutCredit": "UNTIL_SHIFT_END",
  "overtimeEnabled": true,
  "overtimeMinMinutes": 30,
  "breakDeduction": "SHIFT_BREAK",
  "roundingMinutes": 5,
  "minRestHours": 8,
  "maxWeeklyHours": 48
}
```

---

## 10. Attendance Computation & Day Drawer (`/v1/attendance`)

### 10.1 Daily Attendance Statuses
```http
GET /v1/attendance/days?from=2026-03-01&to=2026-03-30&status=PRESENT,LATE&isLate=true&page=1&size=100
```
Filters computed attendance records across employee scopes.

---

### 10.2 Day Drawer Details
```http
GET /v1/attendance/days/:id
```
Detailed inspection modal for an attendance day:
- Computed work date, status, minutes worked, break duration, overtime.
- Complete raw punch stream attributed to this day window.
- Paired work session segments with in/out timestamps.
- Related leave requests, remote authorizations, and correction applications.
- Full chronological audit history.

---

### 10.3 Month Overview & Muster Roll Grid
```http
GET /v1/attendance/overview?month=2026-03&grid=true
```
Returns aggregate totals per employee (Present, Absent, Leave, Late, Overtime minutes), daily tenant-wide distribution, and an optional day-by-day status matrix.

---

### 10.4 Historical Re-evaluate ("Recompute")
```http
POST /v1/attendance/recompute
```
> **Access Control**: `ADMIN`, `HR`. Queues a background BullMQ job to re-evaluate attendance over a historical window, recalculating statuses against updated policies, shifts, or corrections.

```json
{
  "employeeIds": ["88cfc843-e6ef-4613-8991-ecff02a9e334"],
  "from": "2026-03-01",
  "to": "2026-03-15",
  "reason": "Updated attendance grace period policy"
}
```

---

## 11. Attendance Corrections (`/v1/attendance/corrections`)

Allows employees or HR managers to resolve missed punches. When approved, synthetic `CORRECTION` punches are inserted into the punch stream and attendance is recalculated without overwriting hardware logs.

### 11.1 List Corrections
```http
GET /v1/attendance/corrections?status=PENDING&from=&to=&limit=50
```

---

### 11.2 Submit Correction
```http
POST /v1/attendance/corrections
```
```json
{
  "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
  "date": "2026-03-28",
  "in": "09:00",
  "out": "18:00",
  "reason": "Biometric terminal failed to read face at checkout"
}
```

---

### 11.3 Approve / Reject Correction
```http
POST /v1/attendance/corrections/:id/approve
POST /v1/attendance/corrections/:id/reject
```
#### Approve Payload
```json
{ "note": "Verified with team supervisor" }
```
#### Reject Payload
```json
{ "note": "No record of physical presence on CCTV" }
```

---

## 12. Leave Management (`/v1/leave`)

### 12.1 Leave Types (`/v1/leave/types`)
- `GET /v1/leave/types`: List active leave types.
- `POST /v1/leave/types`: Define a leave type (`ADMIN`, `HR`).
- `PATCH /v1/leave/types/:id`: Update leave type rules.
- `DELETE /v1/leave/types/:id`: Deactivate leave type.

#### Leave Type Payload
```json
{
  "code": "CL",
  "name": "Casual Leave",
  "color": "#3B82F6",
  "paid": true,
  "allowHalfDay": true,
  "accrualKind": "MONTHLY",
  "accrualAmount": 1.5,
  "maxBalance": 18,
  "carryForwardMax": 5,
  "allowNegative": false,
  "requiresAttachment": false,
  "minNoticeDays": 2,
  "countsOffDays": false,
  "requiresHrApproval": false
}
```
Accrual runs hourly per tenant (catching up missed months). At the leave-year end (1 April) the positive balance moves to the next year up to `carryForwardMax` (`null` = all of it, `0` = none) and the rest lapses; send `null` to clear `maxBalance` or `carryForwardMax`. Balances (`GET /v1/leave/balances`) report `carriedIn` and `carriedOut` separately.

---

### 12.2 Leave Request Lifecycle
- `POST /v1/leave/requests/preview`: Calculates working days deduction prior to submission.
- `POST /v1/leave/requests`: Submits leave request.
- `GET /v1/leave/requests/:id/attachment`: Generates temporary signed URL for supporting medical document.
- `POST /v1/leave/requests/:id/approve`: Approves leave and decrements ledger balance.
- `POST /v1/leave/requests/:id/reject`: Rejects application.
- `POST /v1/leave/requests/:id/cancel`: Cancels pending or approved leave (automatically credits ledger).

#### Leave Request Submission Payload
```json
{
  "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
  "leaveTypeId": "leave-type-cl",
  "from": "2026-04-10",
  "to": "2026-04-11",
  "startHalf": "FIRST",
  "endHalf": "SECOND",
  "reason": "Family function",
  "attachmentKey": "acme/user-01/cert.pdf"
}
```

---

### 12.3 Balances, Ledger & Adjustments
- `GET /v1/leave/balances?employeeId=&year=2026`: Available, used, and pending leave balances.
- `GET /v1/leave/ledger?employeeId=&leaveTypeId=`: Audit trail of all balance adjustments, accruals, and deductions.
- `POST /v1/leave/adjustments`: Manual HR balance adjustment (`ADMIN`, `HR`).
- `POST /v1/leave/comp-off`: Grants compensatory off credit for working on a holiday or rest day (`ADMIN`, `HR`).

#### Adjustment Payload
```json
{
  "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
  "leaveTypeId": "leave-type-cl",
  "year": 2026,
  "delta": 2.0,
  "kind": "ADJUSTMENT",
  "note": "Correction of opening balance carryover"
}
```

---

## 13. Remote Work (`/v1/remote-work`)

Workflow for remote work permissions enabling mobile GPS punch authorization.
- `GET /v1/remote-work/requests`: List requests.
- `POST /v1/remote-work/requests`: Apply for remote work authorization.
- `POST /v1/remote-work/requests/:id/approve`: Authorize remote work days.
- `POST /v1/remote-work/requests/:id/reject`: Reject application.
- `POST /v1/remote-work/requests/:id/cancel`: Cancel remote authorization.

#### Remote Work Request Payload
```json
{
  "from": "2026-04-02",
  "to": "2026-04-03",
  "reason": "Working from home during client visits"
}
```

---

## 14. Reports & Exports (`/v1/reports`)

### 14.1 Catalogue
```http
GET /v1/reports/types
```
Returns list of available report engines:
1. `daily-summary`: Daily headcount, in/out times, and work duration.
2. `muster-roll`: Government-compliant monthly attendance matrix with daily status codes.
3. `timesheet`: Detailed punch segments and approval sign-off sheets.
4. `punch-log`: Audit log of all raw punch events.
5. `late-early`: Exceptions for late arrivals and early departures.
6. `overtime`: Overtime summaries and compliance tracking.
7. `leave`: Leave utilization and balance summaries.
8. `absenteeism`: Unplanned absenteeism rates and patterns.

---

### 14.2 Request Export Job
```http
POST /v1/reports/exports
```
Queues an asynchronous generation job via BullMQ.

#### Request Body
```json
{
  "type": "muster-roll",
  "format": "pdf",
  "filters": {
    "dateFrom": "2026-03-01",
    "dateTo": "2026-03-31",
    "departmentIds": ["c3562309-842b-45a8-b642-c6cb0e9f1604"]
  }
}
```

#### Response `202 Accepted`
```json
{
  "jobId": "rep-job-94812",
  "status": "queued"
}
```

---

### 14.3 Download Report File
```http
GET /v1/reports/exports/:jobId/download?redirect=true
```
- `redirect=true` (default): Returns `302 Found` redirecting to an authenticated 5-minute Supabase Storage signed download URL.
- `redirect=false`: Returns JSON: `{ "url": "https://...", "expiresInSeconds": 300 }`.

---

### 14.4 Scheduled Automated Reports
Configures recurring cron jobs delivering reports directly to team inboxes.
- `GET /v1/reports/schedules`: List schedules.
- `POST /v1/reports/schedules`: Create schedule (`ADMIN`, `HR`, `MANAGER`).
- `PATCH /v1/reports/schedules/:id`: Update schedule.
- `DELETE /v1/reports/schedules/:id`: Remove schedule.

#### Schedule Creation Payload
```json
{
  "name": "Weekly Monday Absenteeism Brief",
  "type": "absenteeism",
  "format": "csv",
  "filters": {
    "period": "last7"
  },
  "cron": "0 8 * * 1",
  "timezone": "Asia/Kolkata",
  "recipientUserIds": ["92f1b8a5-d0c3-4d7a-8fbe-449e7b231122"],
  "enabled": true
}
```

---

## 15. Live Board, WebSocket Gateway & Audit Logs

### 15.1 REST Live Snapshot (`/v1/live/board`)
```http
GET /v1/live/board?siteId=&departmentId=
```
> **Access Control**: `ADMIN`, `HR`, `MANAGER`.

Returns real-time workforce headcount:
- Live state counts: `IN`, `IN_LATE`, `ON_BREAK`, `LEFT`, `NOT_YET_IN`, `LATE_NOT_IN`, `ON_LEAVE`, `REMOTE`, `OFF`, `ABSENT`.
- Active terminal hardware online/offline statuses.
- Stream of most recent 30 punches.

---

### 15.2 WebSocket Gateway (`/live`)
Socket.IO connection namespace for live delta updates.

```javascript
import { io } from 'socket.io-client';

const socket = io('https://<api-domain>/live', {
  auth: { token: '<jwt-token>' },
  transports: ['websocket']
});
```

#### Gateway Rooms
- `user:<userId>`: Personal notifications, approval requests, report ready events.
- `tenant:<tenantId>`: All tenant-wide events (`ADMIN`, unrestricted `HR`).
- `site:<siteId>`: Site-restricted events.
- `dept:<deptId>`: Department events for department heads.
- `mgr:<employeeId>`: Direct team reporting events.

#### Events Emitted by Server
| Event Name | Room | Payload Description |
|---|---|---|
| `punch.created` | Scope rooms | Real-time punch recorded on terminal or mobile. |
| `attendance.updated` | Scope rooms | Materialized attendance day updated. |
| `device.status` | `tenant:`, `site:` | Terminal connected, disconnected, or heartbeat received. |
| `report.ready` | `user:` | Asynchronous export job completed with download metadata. |
| `report.failed` | `user:` | Export generation failure notification. |
| `approval.pending` | `user:` | New request awaiting supervisor decision. |
| `notification.new` | `user:` | General in-app notification entry. |

---

### 15.3 Audit Logs (`/v1/audit-logs`)
```http
GET /v1/audit-logs?action=&actorUserId=&targetType=&targetId=&from=&to=&page=1&size=50
```
> **Access Control**: `ADMIN`.

Immutable audit log recording every mutation, actor UID, IP/client information, and before/after payloads.

---

## 16. Health & Readiness (`/v1/health`)

> **Access Control**: Public (No JWT required, exempt from rate limiting).

### 16.1 Liveness Probe
```http
GET /v1/health/live
```
#### Response `200 OK`
```json
{
  "status": "ok",
  "time": "2026-03-30T10:20:00.000Z"
}
```

---

### 16.2 Readiness Probe
```http
GET /v1/health/ready
```
Validates connectivity across all critical dependencies:
- PostgreSQL database transaction ping.
- Redis client connectivity ping.
- M50 Terminal Server WebSocket listener attachment.

#### Response `200 OK`
```json
{
  "status": "ok",
  "database": true,
  "redis": true,
  "terminalServer": true
}
```
If any check fails, returns `503 Service Unavailable` with `"code": "NOT_READY"`.
