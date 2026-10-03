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
    "leave": true
  }
}
```

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
Records an in-app remote/field check-in.
- **Authorization**: Allowed if employee policy is `ALWAYS`, or `REMOTE_DAYS` with approved remote work today.
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
  "clientTime": "2026-03-30T09:00:15.000Z"
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
  "accuracy": 12.5
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
Rejects application with a mandatory note explaining the rationale.

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
