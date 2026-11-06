# Iverto Attendance Mobile API Reference (Self-Service & Approvals)

Complete technical specification and integration guide for the Iverto Attendance mobile application endpoints (`/v1/mobile/*`).

---

## 1. Mobile Client Overview & Conventions

### Base URL
- **Production Proxy Base**: `https://<api-domain>/att/v1/mobile`
- **Direct Service Base**: `http://<host>:8040/v1/mobile`

### Authentication & Headers
Every request must include the user's Supabase access token in the `Authorization` header:
```http
Authorization: Bearer <access_token>
Content-Type: application/json
```

#### Supported Standard Roles
- `EMPLOYEE`: Access to personal attendance, schedules, leave requests, remote check-ins, and notifications.
- `MANAGER`, `HR`, `ADMIN`: Access to employee self-service plus the Mobile Approvals Queue and Live Team Board.

#### Idempotency (`Idempotency-Key`)
Mobile networks are prone to intermittent connection drops. All mutating `POST` endpoints support an `Idempotency-Key` header:
```http
Idempotency-Key: <client-generated-uuid-or-unique-key>
```
- **TTL**: Keys are cached in Redis for 24 hours.
- **In-Flight Protection**: A retry sent while the initial request is executing returns `409 Conflict` with `"code": "IDEMPOTENCY_IN_PROGRESS"`.
- **Replay Guarantee**: Retrying the same key after successful completion returns the exact previously generated HTTP response body without performing the mutation twice (e.g. preventing duplicate punches or double leave applications).

#### Rate Limiting
- **General Mobile Surface**: 120 requests/minute per authenticated user.
- **Password Modification**: 10 requests/minute.

#### Standard Error Response
All mobile endpoints return standardized errors matching:
```json
{
  "statusCode": 400,
  "code": "BAD_REQUEST",
  "message": "Human-readable explanation of error",
  "details": []
}
```

---

## 2. Profile, Session & Security

### 2.1 Get Authenticated Profile (`/me`)
```http
GET /v1/mobile/me
```
> **Notes**: Accessible even when `mustChangePassword` is `true`. Used immediately upon login to configure client routing and feature visibility.

#### Response `200 OK`
```json
{
  "userId": "92f1b8a5-d0c3-4d7a-8fbe-449e7b231122",
  "email": "rahul.sharma@acme.com",
  "displayName": "Rahul Sharma",
  "role": "EMPLOYEE",
  "mustChangePassword": false,
  "organisation": {
    "id": "18f97e23-74cf-4ca6-b8f2-d853e3d98c11",
    "name": "Acme Manufacturing Ltd",
    "logoUrl": "https://assets.acme.com/branding/logo.png",
    "primaryColor": "#1E40AF"
  },
  "employee": {
    "id": "88cfc843-e6ef-4613-8991-ecff02a9e334",
    "employeeCode": "EMP-0412",
    "fullName": "Rahul Sharma",
    "designation": "Field Specialist",
    "department": {
      "id": "c3562309-842b-45a8-b642-c6cb0e9f1604",
      "name": "Field Operations"
    },
    "site": {
      "id": "05d53cb1-efec-4be8-8422-44673891d4e0",
      "name": "Pune Headquarters",
      "timezone": "Asia/Kolkata"
    },
    "manager": {
      "id": "2bf51cc7-2287-4d92-95f7-920f92b02441",
      "fullName": "Ananya Joshi",
      "phone": "+919876500000",
      "email": "ananya.joshi@acme.com"
    },
    "joinedOn": "2026-01-15"
  },
  "features": {
    "mobilePunch": "REMOTE_DAYS",
    "canApprove": false,
    "teamView": false,
    "remoteWork": true,
    "leave": true,
    "fieldVisits": true
  }
}
```

#### Feature flags
- `features.leave` is `false` for a login without an employee record, and for **interns** when the organisation has the interns setting on (interns have no leave). Hide the leave tab then; leave routes return `400 NO_LEAVE_FOR_INTERNS`.
- `features.mobilePunch` is `NEVER`, `REMOTE_DAYS`, `ALWAYS` or `FULL_REMOTE` (fully remote employee: may always punch from the app, and every working day counts as remote).
- `features.fieldVisits`: show the field-visit button (§7A).

#### Two-factor sign-in is web-only
The web app requires an authenticator-app code at every sign-in. The mobile app does **not**: every `/v1/mobile/*` route, plus `GET /v1/org`, `GET /v1/departments` and `GET /v1/attendance/overview` (leaderboard, §10.6), accept a password-only session. Any other `/v1` route returns `403 MFA_REQUIRED` to a mobile token, so don't call web routes beyond those.

#### Forgot password
The sign-in screen's "Forgot password?" calls `POST /v1/auth/forgot-password` with `{ "email": "…" }` (no `Authorization` header). It always answers `201 { "ok": true }`, whether or not the account exists, so show "If an account exists, we've e-mailed a link". The e-mailed link opens the web app's reset page; the new password then works in the mobile app too. A reset signs the user out on every device.

#### Organisation branding
Show the org's own logo and name in the app header and drawer instead of the Iverto logo, with a small "Powered by iverto.ai" line at the bottom of the drawer or settings screen. Admins set both under **Settings → Organisation** on the web; reports use the same values.

| Field | Meaning |
|---|---|
| `organisation.name` | The display name, or the organisation name if no display name is set. Never null. |
| `organisation.logoUrl` | An https image URL, or `null`. When it's `null`, or the image fails to load, show the bundled Iverto logo. The URL is public, so load it without the `Authorization` header and cache it by URL. |
| `organisation.primaryColor` | An optional `#RRGGBB` accent colour, or `null`. |

Re-read `/me` on app start and on resume, so a logo change shows up without needing to sign in again.

#### Logins without an employee record
Admins and HR users don't need an employee record (an organisation's first admin never has one). For them `employee` is `null` and `features.leave` / `features.remoteWork` are `false`. The app must still open for them: the self-service reads below return empty data instead of an error, so the home screen can lead with the team board and approvals.

| Endpoint | Without an employee record |
|---|---|
| `GET /v1/mobile/today` | `day: null`, `punches: []`, `nextShift: null`, `mobilePunch: { "mode": "NEVER", "allowedNow": false }` |
| `GET /v1/mobile/attendance?month=` | `days: []`, every total `0` |
| `GET /v1/mobile/attendance/:date` | `404 NOT_FOUND` |
| `GET /v1/mobile/schedule` | `days: []` |
| `GET /v1/mobile/holidays` | `holidays: []` |
| `GET /v1/mobile/leave/balances` | `employeeId: null`, `balances: []` |
| `GET /v1/mobile/leave/types` | `[]` |

Actions taken as the employee (mobile punch, leave, corrections, remote work, check-ins) still return `403 NO_EMPLOYEE`, so hide them when `employee` is `null`.

---

### 2.2 Change Password
```http
POST /v1/mobile/password
```
> **Notes**: Used to replace initial temporary passwords or update current credentials.

#### Request Body
```json
{
  "currentPassword": "Initial-Temp-Password!1",
  "newPassword": "MyNewSecureMobilePass#2026"
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

## 3. Push Notifications & In-App Inbox

### 3.1 Register Push Device (FCM Token)
```http
POST /v1/mobile/push-devices
```
Registers an Android or iOS device token for Firebase Cloud Messaging push alerts.

#### Request Body
```json
{
  "token": "eXamP1e-Fcm-ToKen-sTr1ng-vALue-4096-ChArS",
  "platform": "android"
}
```

#### Response `200 OK`
```json
{
  "status": "registered"
}
```

---

### 3.2 Unregister Push Device
```http
DELETE /v1/mobile/push-devices/:token
```
Called on user logout to prevent subsequent notifications from reaching the device.

---

### 3.3 Notification Inbox
```http
GET /v1/mobile/notifications?cursor=&limit=30
```
Cursor-paginated list of notifications delivered to the user's account.

#### Response `200 OK`
```json
{
  "items": [
    {
      "id": "notif-01",
      "type": "LEAVE_APPROVED",
      "title": "Leave approved",
      "body": "Your leave request for 2026-04-10 has been approved.",
      "readAt": null,
      "createdAt": "2026-03-30T09:30:00.000Z",
      "data": {
        "id": "leave-req-12"
      }
    }
  ],
  "unreadCount": 1,
  "nextCursor": null
}
```

---

### 3.4 Mark Notifications as Read
```http
POST /v1/mobile/notifications/read
```
#### Request Body
To mark specific notifications:
```json
{
  "ids": ["notif-01", "notif-02"]
}
```
Or to mark all unread notifications:
```json
{
  "all": true
}
```

#### Response `200 OK`
```json
{
  "updated": 2
}
```

---

## 4. Attendance & Live Time Tracking

### 4.1 Today's Live Attendance Dashboard
```http
GET /v1/mobile/today
```
Returns current work shift context, real-time punch state, session segments, and mobile punch eligibility for the active day window.

#### Response `200 OK`
```json
{
  "timezone": "Asia/Kolkata",
  "now": "2026-03-30T09:45:00.000Z",
  "day": {
    "id": "day-2026-03-30",
    "workDate": "2026-03-30",
    "status": "PRESENT",
    "code": "P",
    "dayType": "WORKING",
    "shiftName": "General Day Shift",
    "isLate": false,
    "workedMinutes": 45,
    "firstIn": "2026-03-30T09:00:00.000Z",
    "lastOut": null,
    "local": {
      "firstIn": "09:00",
      "lastOut": null,
      "schedStart": "09:00",
      "schedEnd": "18:00"
    },
    "shift": {
      "id": "shift-01",
      "name": "General Day Shift",
      "code": "GEN",
      "color": "#10B981"
    }
  },
  "punches": [
    {
      "id": "p-101",
      "punchedAt": "2026-03-30T09:00:00.000Z",
      "localTime": "2026-03-30 09:00:00",
      "direction": "in",
      "source": "MOBILE",
      "deviceName": null
    }
  ],
  "nextShift": {
    "date": "2026-03-31",
    "shift": {
      "id": "shift-01",
      "name": "General Day Shift",
      "code": "GEN",
      "color": "#10B981"
    },
    "start": "2026-03-31T03:30:00.000Z",
    "end": "2026-03-31T12:30:00.000Z",
    "local": {
      "start": "09:00",
      "end": "18:00"
    }
  },
  "mobilePunch": {
    "mode": "REMOTE_DAYS",
    "allowedNow": true
  }
}
```

---

### 4.2 Monthly Calendar View
```http
GET /v1/mobile/attendance?month=2026-03
```
Month overview used to render mobile calendar grids, heatmaps, and monthly summary metrics.

#### Response `200 OK`
```json
{
  "month": "2026-03",
  "timezone": "Asia/Kolkata",
  "days": [
    {
      "date": "2026-03-01",
      "dayId": "day-01",
      "status": "WEEKLY_OFF",
      "code": "WO",
      "dayType": "WEEKLY_OFF",
      "holidayName": null,
      "isLate": false,
      "missedPunch": false,
      "workedMinutes": 0,
      "firstIn": null,
      "lastOut": null
    },
    {
      "date": "2026-03-02",
      "dayId": "day-02",
      "status": "PRESENT",
      "code": "P",
      "dayType": "WORKING",
      "holidayName": null,
      "isLate": false,
      "missedPunch": false,
      "workedMinutes": 510,
      "firstIn": "08:55",
      "lastOut": "18:05"
    }
  ],
  "totals": {
    "present": 21,
    "remote": 2,
    "halfDay": 0,
    "absent": 0,
    "leave": 1.0,
    "holidays": 1,
    "weeklyOff": 4,
    "late": 1,
    "workedMinutes": 10450,
    "overtimeMinutes": 120
  }
}
```

---

### 4.3 Day Detail View
```http
GET /v1/mobile/attendance/:date
```
Detailed inspection for an individual day (formatted `YYYY-MM-DD`). Includes paired work segments, exact punch stream, and applied correction records.

#### Response `200 OK`
```json
{
  "id": "day-02",
  "workDate": "2026-03-02",
  "status": "PRESENT",
  "code": "P",
  "shiftName": "General Day Shift",
  "workedMinutes": 510,
  "segments": [
    {
      "in": "2026-03-02T03:25:00.000Z",
      "out": "2026-03-02T12:35:00.000Z",
      "credited": false,
      "local": {
        "in": "08:55",
        "out": "18:05"
      }
    }
  ],
  "punches": [
    {
      "id": "punch-01",
      "punchedAt": "2026-03-02T03:25:00.000Z",
      "direction": "in",
      "source": "TERMINAL",
      "deviceName": "Main Entrance Turnstile"
    },
    {
      "id": "punch-02",
      "punchedAt": "2026-03-02T12:35:00.000Z",
      "direction": "out",
      "source": "TERMINAL",
      "deviceName": "Main Entrance Turnstile"
    }
  ],
  "corrections": []
}
```

---

### 4.4 Mobile GPS Punch Submission
```http
POST /v1/mobile/punches
```
Records an in-app remote/field check-in: a geo-tagged selfie plus the GPS fix. Step-by-step guide with Android code: [`remote_checkin_mobile_api.md`](./remote_checkin_mobile_api.md).
- **Authorization**: Allowed if employee policy is `ALWAYS` or `FULL_REMOTE`, or `REMOTE_DAYS` with approved remote work today.
- **Selfie (required)**: `selfieBase64` is a base64 JPEG taken with the front camera at the moment of the punch, at most **2 MB** decoded (resize to ~720 px wide, quality 80 is plenty). Non-JPEG → `400 FILE_TYPE_MISMATCH`; too large → `413 FILE_TOO_LARGE`. The server stores it in a private Azure Blob container; the app never talks to Azure directly.
- **Review**: Every mobile punch is created with `reviewStatus: "PENDING"` and counts towards the day immediately. A manager/HR/admin then approves or rejects it; a rejected punch (`reviewStatus: "REJECTED"`, `outcome: "DENIED"`) drops out of the day's attendance and the employee receives a `MOBILE_PUNCH_REJECTED` notification. `GET /v1/mobile/today` and `/v1/mobile/attendance/:date` return `reviewStatus` / `reviewNote` on each punch so the app can show the state.
- **Server Timestamp**: The server's timestamp is authoritative; `clientTime` is preserved strictly for diagnostic audit.
- **Idempotency**: Pass `Idempotency-Key` to safely handle poor network connections.

#### Request Body
```json
{
  "direction": "in",
  "lat": 18.52043,
  "lng": 73.85674,
  "accuracy": 12.5,
  "isMockLocation": false,
  "clientTime": "2026-03-30T09:00:15.000Z",
  "selfieBase64": "/9j/4AAQSkZJRgABAQ..."
}
```

#### Response `201 Created`
```json
{
  "id": "p-101",
  "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
  "punchedAt": "2026-03-30T09:00:16.210Z",
  "direction": "in",
  "source": "MOBILE",
  "lat": 18.52043,
  "lng": 73.85674,
  "accuracy": 12.5,
  "reviewStatus": "PENDING"
}
```

---

## 5. Schedules & Holidays

### 5.1 Rolling Work Schedule (14 Days)
```http
GET /v1/mobile/schedule?from=&to=
```
Defaults to the current date and the subsequent 13 days (2-week horizon).

#### Response `200 OK`
```json
{
  "timezone": "Asia/Kolkata",
  "days": [
    {
      "date": "2026-03-30",
      "dayType": "WORKING",
      "holidayName": null,
      "shift": {
        "id": "shift-01",
        "name": "General Day Shift",
        "code": "GEN",
        "color": "#10B981"
      },
      "start": "2026-03-30T03:30:00.000Z",
      "end": "2026-03-30T12:30:00.000Z",
      "local": {
        "start": "09:00",
        "end": "18:00"
      },
      "override": false
    }
  ]
}
```

---

### 5.2 Yearly Holiday Calendar
```http
GET /v1/mobile/holidays?year=2026
```
Returns list of official organization holidays assigned to the employee's work site.

#### Response `200 OK`
```json
{
  "year": 2026,
  "holidays": [
    {
      "date": "2026-01-26",
      "name": "Republic Day"
    },
    {
      "date": "2026-05-01",
      "name": "Labor Day"
    },
    {
      "date": "2026-08-15",
      "name": "Independence Day"
    }
  ]
}
```

---

## 6. Leave Management & Requests

### 6.1 Available Balances
```http
GET /v1/mobile/leave/balances?year=2026
```
Returns balance summaries for all configured leave types for the employee.

#### Response `200 OK`
```json
{
  "year": 2026,
  "balances": [
    {
      "leaveType": {
        "id": "lt-cl",
        "code": "CL",
        "name": "Casual Leave",
        "color": "#3B82F6",
        "paid": true
      },
      "allocated": 12.0,
      "used": 3.0,
      "pending": 1.0,
      "available": 8.0
    }
  ]
}
```

---

### 6.2 Leave Types Form Metadata
```http
GET /v1/mobile/leave/types
```
Supplies dynamic form constraints and eligibility flags required when populating leave request submission pickers.

#### Response `200 OK`
```json
[
  {
    "id": "lt-cl",
    "code": "CL",
    "name": "Casual Leave",
    "color": "#3B82F6",
    "paid": true,
    "allowHalfDay": true,
    "requiresAttachment": false,
    "minNoticeDays": 2,
    "countsOffDays": false,
    "allowNegative": false,
    "available": 8.0
  }
]
```

---

### 6.3 Leave Deduction Preview
```http
POST /v1/mobile/leave/requests/preview
```
Computes the exact working days deduction (omitting holidays or rest days based on leave type rules) and checks for balance sufficiency or date overlaps before the user submits.

#### Request Body
```json
{
  "leaveTypeId": "lt-cl",
  "from": "2026-04-10",
  "to": "2026-04-13",
  "startHalf": "FIRST",
  "endHalf": "SECOND"
}
```

#### Response `200 OK`
```json
{
  "workingDays": 2.0,
  "available": 8.0,
  "sufficient": true,
  "breakdown": [
    { "date": "2026-04-10", "type": "WORKING", "deduction": 1.0 },
    { "date": "2026-04-11", "type": "WEEKLY_OFF", "deduction": 0.0 },
    { "date": "2026-04-12", "type": "WEEKLY_OFF", "deduction": 0.0 },
    { "date": "2026-04-13", "type": "WORKING", "deduction": 1.0 }
  ]
}
```

---

### 6.4 Submit Leave Request
```http
POST /v1/mobile/leave/requests
Header: Idempotency-Key: <unique-uuid>
```
Applies for leave. If `requiresAttachment` is true, upload the supporting file first via `/v1/mobile/uploads` and pass its `key` in `attachmentKey`.

#### Request Body
```json
{
  "leaveTypeId": "lt-cl",
  "from": "2026-04-10",
  "to": "2026-04-13",
  "startHalf": "FIRST",
  "endHalf": "SECOND",
  "reason": "Family vacation",
  "attachmentKey": null
}
```

#### Response `201 Created`
```json
{
  "id": "leave-req-88",
  "status": "PENDING",
  "startDate": "2026-04-10",
  "endDate": "2026-04-13",
  "daysCount": 2.0
}
```

---

### 6.5 My Leave History
```http
GET /v1/mobile/leave/requests?status=PENDING&cursor=&limit=20
```
Cursor-paginated personal leave history.

---

### 6.6 Cancel Leave Request
```http
POST /v1/mobile/leave/requests/:id/cancel
```
Cancels a pending or previously approved leave request. If previously approved, the employee's leave balance is automatically reversed and credited back.

#### Request Body
```json
{
  "note": "Trip cancelled"
}
```

---

## 7. Attendance Corrections (Missed Punches)

### 7.1 My Correction Requests
```http
GET /v1/mobile/corrections?cursor=&limit=20
```

---

### 7.2 Submit Attendance Correction
```http
POST /v1/mobile/corrections
Header: Idempotency-Key: <unique-uuid>
```
Allows employees to propose in/out times for days with missed punches or hardware failures.

#### Request Body
```json
{
  "date": "2026-03-27",
  "in": "09:05",
  "out": "18:10",
  "reason": "Terminal was offline during morning entry"
}
```
- `fieldVisitId` (optional): attach one of **your own** field visits (§7A) as proof, e.g. the visit taken at the client's when you left. Someone else's visit, or an unknown id → `400 BAD_PROOF`.

```json
{
  "date": "2026-03-27",
  "out": "18:10",
  "reason": "Went to Acme Ltd after lunch and left from there",
  "fieldVisitId": "fv-31"
}
```

Corrections returned by §7.1 and the approvals queue carry `fieldVisit` (`null` when no proof was attached), with the same fields as §7A plus a fresh 1-hour `photoUrl`.

#### Response `201 Created`
```json
{
  "id": "corr-54",
  "status": "PENDING",
  "workDate": "2026-03-27",
  "inAt": "2026-03-27T03:35:00.000Z",
  "outAt": "2026-03-27T12:40:00.000Z",
  "reason": "Terminal was offline during morning entry"
}
```

---

## 7A. Field Visits (Geotagged Proof)

For staff who leave the office during the day for a client's site and go home from there without punching out on the terminal. A **field visit** is a selfie + GPS fix + **server** timestamp taken in the app, kept as proof that the person was working at that place and time. It is **not** a punch and never changes attendance on its own. Later, the employee requests a correction (§7.2) and attaches the visit as proof; the approver sees the photo on a map on the web before approving.

Show the feature when `/me` → `features.fieldVisits` is `true` (any login linked to an employee). Suggested UI: a "Field visit" button on the home screen, and a "Proof" picker on the correction form listing that day's visits.

### 7A.1 Record a Field Visit
```http
POST /v1/mobile/field-visits
Header: Idempotency-Key: <unique-uuid>
```
- **Selfie (required)**: same rules as the mobile punch (§4.4): base64 JPEG from the front camera, taken in-app at that moment (no gallery picks), at most **2 MB** decoded. Non-JPEG → `400 FILE_TYPE_MISMATCH`; too large → `413 FILE_TOO_LARGE`.
- **Time**: the server's receive time is stored as `takenAt`. Don't queue visits offline and send them later; they'd be stamped with the send time.
- `note` (optional, ≤ 500 chars): e.g. the client's name.
- No employee record → `403 NO_EMPLOYEE`; exited → `403 EMPLOYEE_EXITED`.

#### Request Body
```json
{
  "lat": 18.52043,
  "lng": 73.85674,
  "accuracy": 12.5,
  "isMockLocation": false,
  "note": "Acme Ltd, Hinjewadi",
  "selfieBase64": "/9j/4AAQSkZJRgABAQ..."
}
```

#### Response `201 Created`
```json
{
  "id": "fv-31",
  "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
  "employee": { "fullName": "Rahul Sharma", "employeeCode": "EMP-0412" },
  "takenAt": "2026-03-27T12:40:16.210Z",
  "local": "2026-03-27 18:10",
  "timezone": "Asia/Kolkata",
  "lat": 18.52043,
  "lng": 73.85674,
  "accuracy": 12.5,
  "isMockLocation": false,
  "note": "Acme Ltd, Hinjewadi",
  "photoUrl": "https://<account>.blob.core.windows.net/punch-selfies/...&sig=..."
}
```
`photoUrl` is a read link valid for 1 hour; re-fetch the list rather than caching it.

### 7A.2 My Field Visits
```http
GET /v1/mobile/field-visits?date=2026-03-27&cursor=&limit=20
```
Newest first. `date` (optional, `YYYY-MM-DD`) narrows to that local day in the employee's site timezone, which is what the correction form's proof picker needs. Returns `{ "data": [ <field visit as above> ], "nextCursor": null }`.

---

## 8. Remote Work Requests

### 8.1 My Remote Work Applications
```http
GET /v1/mobile/remote-work?cursor=&limit=20
```

---

### 8.2 Apply for Remote Work
```http
POST /v1/mobile/remote-work
Header: Idempotency-Key: <unique-uuid>
```
Applies for single or multi-day remote permission. Once approved, the employee is authorized to punch via `/v1/mobile/punches` on those dates.

#### Request Body
```json
{
  "from": "2026-04-02",
  "to": "2026-04-03",
  "reason": "Attending local vendor audits"
}
```

#### Response `201 Created`
```json
{
  "id": "rem-22",
  "status": "PENDING",
  "startDate": "2026-04-02",
  "endDate": "2026-04-03",
  "reason": "Attending local vendor audits"
}
```

---

## 9. File Uploads (Supporting Documents)

### 9.1 Upload Document Attachment
```http
POST /v1/mobile/uploads
```
Uploads a base64-encoded file directly to private tenant storage. Validates actual byte signatures (magic bytes) to guarantee file safety.

- **Maximum Size**: 5 MB (`5,242,880` bytes).
- **Supported Content Types**: `image/jpeg`, `image/png`, `application/pdf`.

#### Request Body
```json
{
  "fileName": "medical_certificate.pdf",
  "contentType": "application/pdf",
  "dataBase64": "JVBERi0xLjQKJ..."
}
```

#### Response `201 Created`
```json
{
  "key": "tenant-id/user-id/e1a5f421-2290-48e0-bb12-0fbc38708c90.pdf",
  "size": 142050,
  "contentType": "application/pdf"
}
```
The returned `key` can then be supplied in `attachmentKey` when calling `/v1/mobile/leave/requests`.

---

## 10. Manager Portal & Approvals (Mobile On-the-Go)

> **Access Control**: Users with `role` in `MANAGER`, `HR`, or `ADMIN`.

### 10.1 Live Team Headcount
```http
GET /v1/mobile/team/live
```
Provides real-time visibility into the status of direct and department reports.

#### Response `200 OK`
```json
{
  "generatedAt": "2026-03-30T10:00:00.000Z",
  "summary": {
    "present": 18,
    "late": 2,
    "absent": 1,
    "notYetIn": 3,
    "onLeave": 2,
    "remote": 1,
    "off": 0,
    "scheduled": 25
  },
  "counts": {
    "IN": 14,
    "IN_LATE": 2,
    "ON_BREAK": 2,
    "LEFT": 0,
    "NOT_YET_IN": 3,
    "LATE_NOT_IN": 0,
    "ON_LEAVE": 2,
    "REMOTE": 1,
    "OFF": 0,
    "ABSENT": 1
  },
  "people": [
    {
      "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
      "fullName": "Rahul Sharma",
      "employeeCode": "EMP-0412",
      "liveState": "IN",
      "isLate": false,
      "firstIn": "09:00",
      "lastOut": null,
      "shiftStart": "09:00"
    }
  ],
  "offlineDevices": [
    {
      "id": "dev-03",
      "name": "Warehouse Gate",
      "gateName": "South Gate"
    }
  ]
}
```

---

### 10.2 Team Attendance History
```http
GET /v1/mobile/team/attendance?date=2026-03-30
```
Detailed attendance list of all team members for a given calendar date.

---

### 10.3 Unified Approvals Queue
```http
GET /v1/mobile/approvals?type=leave&cursor=&limit=30
```
Single consolidated queue for supervisor actions.
- `type`: `leave`, `correction`, or `remote`.
- Automatically excludes the caller's own personal requests.

#### Response `200 OK`
```json
{
  "data": [
    {
      "id": "leave-req-88",
      "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
      "employee": {
        "id": "88cfc843-e6ef-4613-8991-ecff02a9e334",
        "fullName": "Rahul Sharma",
        "employeeCode": "EMP-0412"
      },
      "leaveType": {
        "id": "lt-cl",
        "code": "CL",
        "name": "Casual Leave"
      },
      "startDate": "2026-04-10",
      "endDate": "2026-04-13",
      "daysCount": 2.0,
      "reason": "Family vacation",
      "status": "PENDING"
    }
  ],
  "nextCursor": null
}
```

---

### 10.4 Approve Request
```http
POST /v1/mobile/approvals/:type/:id/approve
Header: Idempotency-Key: <unique-uuid>
```
- `:type`: `leave`, `correction`, or `remote`.
- `:id`: ID of the target request.

#### Request Body
```json
{
  "note": "Approved as per team discussion"
}
```

#### Response `200 OK`
```json
{
  "id": "leave-req-88",
  "status": "APPROVED",
  "decisionNote": "Approved as per team discussion"
}
```

---

### 10.5 Reject Request
```http
POST /v1/mobile/approvals/:type/:id/reject
Header: Idempotency-Key: <unique-uuid>
```
Rejects application with a mandatory note explaining the rationale (at least 3 characters; otherwise `400 REASON_REQUIRED`). Any level can reject; see §11.3.

#### Request Body
```json
{
  "note": "Insufficient shift coverage on selected dates"
}
```

#### Response `200 OK`
```json
{
  "id": "leave-req-88",
  "status": "REJECTED",
  "decisionNote": "Insufficient shift coverage on selected dates"
}
```

---

### 10.6 Attendance Leaderboard
There is no `/v1/mobile/leaderboard` route. The web leaderboard ranks people **on the client** from two shared (non-mobile) endpoints. A mobile client should do the same.

> **Base path**: these routes are under `/v1`, not `/v1/mobile` (e.g. `https://<api-domain>/att/v1/attendance/overview`). The same Bearer token works.
>
> **Scope**: rows are limited to what the caller can see. `ADMIN`/`HR` see the whole tenant, `MANAGER` sees self + direct reports + departments they head, and `EMPLOYEE` sees only their own row. Site-restricted users only see their sites.

#### Step 1: Monthly totals
```http
GET /v1/attendance/overview?month=2026-03&siteId=&departmentId=
```
- `month` (required): `YYYY-MM`.
- `siteId`, `departmentId` (optional): filters.

Use `totals[]` and ignore `distribution`. Only employees with at least one attendance day in the month are returned.

```json
{
  "totals": [
    {
      "employee": {
        "id": "88cfc843-e6ef-4613-8991-ecff02a9e334",
        "fullName": "Rahul Sharma",
        "employeeCode": "EMP-0412",
        "departmentId": "dep-ops",
        "siteId": "site-blr"
      },
      "counts": {
        "PENDING": 2, "PRESENT": 18, "HALF_DAY": 1, "ABSENT": 1, "ON_LEAVE": 1,
        "HALF_LEAVE": 0, "REMOTE": 1, "HOLIDAY": 1, "WEEKLY_OFF": 5
      },
      "lateDays": 4,
      "lateDeductionDays": 1,
      "workedMinutes": 10120,
      "overtimeMinutes": 240,
      "lateMinutes": 85,
      "earlyExitMinutes": 0
    }
  ],
  "distribution": [ { "date": "2026-03-01", "counts": { "PRESENT": 20 } } ]
}
```
- `lateDays`: days flagged late.
- `lateDeductionDays`: late penalty in days. Computed server-side as `floor(lateDays / lateDeductionEvery) × (0.5 for HALF_DAY | 1 for FULL_DAY)` using the policy frozen on the employee's latest day of the month. It is `0` when the policy's `lateDeduction` is `NONE`.

#### Step 2: Leave setting
```http
GET /v1/org
```
Read `settings.leaveCountsAgainstAttendance` (boolean, default `false`). Department names come from `GET /v1/departments`.

#### Step 3: Score and rank (client-side)
Let `c = counts` (missing key = 0). Sum these over one employee, or over every employee in a department for the department view:

| Field | Formula |
|---|---|
| `working` | `PRESENT + REMOTE + HALF_DAY + ABSENT` + (`leaveCounts` ? `ON_LEAVE + HALF_LEAVE` : `HALF_LEAVE / 2`) |
| `present` | `PRESENT + REMOTE + (HALF_DAY + HALF_LEAVE) / 2` |
| `leave` | `ON_LEAVE + HALF_LEAVE / 2` |
| `absent` | `ABSENT + HALF_DAY / 2` |
| `turnedUp` | `PRESENT + REMOTE + HALF_DAY + HALF_LEAVE` |
| `attendancePct` | `max(0, present − Σ lateDeductionDays) / working × 100`, or `null` when `working = 0` |
| `latePct` | `min(100, Σ lateDays / turnedUp × 100)`, or `0` when `turnedUp = 0` |

`PENDING` (today and future days), `HOLIDAY` and `WEEKLY_OFF` are left out. Unapproved absences are `ABSENT` and always count.

**Sort order**: highest `attendancePct` first. Ties go to the lower `latePct`. A `null` attendance ranks last. Rank is the 1-based position after sorting.

Reference implementation: `apps/web/src/lib/leaderboard.ts` (`score`, `byRank`).


---

## 11. Leave Policy Engine, Permission, Approval Tracker & Geofence (Nov 2026)

Every organisation configures its own leave policy on the web; the app only reads what the API returns. Nothing below is tenant-specific in the app.

### 11.1 What the app sees

- `GET /v1/mobile/me` → `employee.employmentType` (the organisation's own category code, e.g. `PERMANENT`, `TEMPORARY`, `INTERN`) and `employee.site.geofence` (`{ lat, lng, radiusM, strict }` or `null`).
- `GET /v1/mobile/leave/types` lists **only the types this person is eligible for** (their category may be excluded, or a person-level override may exclude them). New fields per type:
  - `unit`: `DAYS` or `HOURS`. `HOURS` types (e.g. *Permission*) are taken as a time range on one day.
  - `available`: `null` for unlimited types (Loss of Pay, Permission) — they have no balance; don't show "0 left".
  - `eligibleFrom`: first date the person may apply (joining date + minimum service / probation).
  - `quota`: `null`, or this month's usage `{ month, unit, used, requests, limit, maxRequests }` — e.g. `{ used: 2.5, requests: 2, limit: 4, maxRequests: 3, unit: "HOURS" }` means 2.5 of 4 hours used, in 2 of 3 allowed requests.
- `GET /v1/mobile/leave/balances` rows add `entitlement { amount, eligible, overridden, eligibleFrom }`, `unlimited`, `quota`, and `leaveType.unit`.

### 11.2 Applying for hourly leave (Permission)

For a `unit: "HOURS"` type, send one date and local times (`HH:mm`, the employee's site timezone). No halves.

```json
POST /v1/mobile/leave/requests/preview   (then POST /v1/mobile/leave/requests with the same body)
{ "leaveTypeId": "…", "from": "2026-12-02", "to": "2026-12-02", "startTime": "09:00", "endTime": "10:30", "reason": "Bank work" }
```

Preview/response add `startTime`, `endTime`, `minutes`, `hours` (`days` is `0`) and `quota`. New preview error codes:

| Code | Show |
|---|---|
| `MONTHLY_LIMIT_EXCEEDED` | Goes over this month's limit (e.g. 4 hours) |
| `MONTHLY_REQUESTS_EXCEEDED` | No requests of this type left this month (e.g. 3) |
| `NOT_ELIGIBLE` | Not available for your category |
| `ELIGIBLE_FROM_YYYY-MM-DD` | Not eligible until that date (minimum service) |

`400 BAD_RANGE` (from ≠ to) and `400 BAD_TIME_RANGE` (missing/out-of-order times) are thrown before the preview. Only one leave/permission request per person per day. An approved permission counts towards the day's hours and excuses lateness/early exit it covers (`permissionMinutes` on attendance days).

### 11.3 Approval tracker (one or two levels)

Leave types (per type) and remote work (per organisation) can need **manager, then HR/admin**. Every item in `GET /v1/mobile/leave/requests` and `GET /v1/mobile/remote-work` now carries `progress` — render it as an order-tracking stepper:

```json
"progress": {
  "levels": 2,
  "stage": "HR",                       // MANAGER | HR | APPROVED | REJECTED | CANCELLED
  "steps": [
    { "key": "SUBMITTED", "label": "Submitted",          "state": "done",     "at": "2026-11-05T05:10:00Z", "by": "Pooja", "note": null },
    { "key": "MANAGER",   "label": "Manager approval",   "state": "done",     "at": "2026-11-05T06:00:00Z", "by": "Manoj", "note": null },
    { "key": "HR",        "label": "HR / admin approval","state": "current",  "at": null, "by": null, "note": null },
    { "key": "APPROVED",  "label": "Approved",           "state": "upcoming", "at": null, "by": null, "note": null }
  ]
}
```

`state` is `done | current | upcoming | rejected | cancelled | skipped` (`skipped`: HR approved directly, no manager step needed). A rejection stops at its step with the reason in `note`; the last step's label becomes `Rejected` / `Cancelled`. The request `status` stays `PENDING` until the final level approves.

Approvers: in two-level flows a manager's approve returns `status: "PENDING"` (passed to HR) and the item leaves the manager's `GET /v1/mobile/approvals` queue (for both `leave` and `remote`). A second manager approve → `409 AWAITING_HR`. New notification types: `LEAVE_MANAGER_APPROVED`, `REMOTE_MANAGER_APPROVED` (to the employee).

**Rejecting always needs a reason** (any level): `POST /v1/mobile/approvals/:type/:id/reject` without a `note` of at least 3 characters → `400 REASON_REQUIRED`. Make the reason field mandatory in the reject dialog.

### 11.4 Mobile punch: geofence and several sessions a day

- If the employee's site has a geofence, `POST /v1/mobile/punches` inside the radius (and `isMockLocation` not `true`) comes back `reviewStatus: "APPROVED"` with `reviewNote: "Auto-approved: 14 m from <site>"`. Outside it is `PENDING` (`reviewNote: "Outside geofence: 850 m from <site>"`) for a manager — or, on a **strict** site, refused with `403 OUTSIDE_GEOFENCE` (message says how far away they are). Show the distance hint before punching using `mobilePunch.geofence` from `GET /v1/mobile/today`.
- Any number of in/out sessions per day are counted. `GET /v1/mobile/today` → `mobilePunch.nextDirection` (`in` | `out`) is the opposite of the last counted punch: drive the punch button from it instead of assuming one in and one out per day.
