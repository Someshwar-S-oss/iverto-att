# Remote Attendance Check-in — Mobile API

How the Android app marks attendance for an employee who is working remotely: a **geo-tagged selfie** plus the device's **GPS fix**, sent in one request. The server stores the selfie in Azure Blob Storage, records the punch, and puts it in a manager's review queue.

This is a focused guide for the Android developer. The full mobile reference is [`mobile_api.md`](./mobile_api.md).

---

## 1. Flow at a glance

```
Employee (app)                        API                                   Manager (web)
──────────────                        ───                                   ─────────────
1. GET  /mobile/me          ───────▶  features.mobilePunch = REMOTE_DAYS | ALWAYS | NEVER
2. POST /mobile/remote-work ───────▶  request PENDING  ─────────────────▶  approves request
                            ◀───────  push REMOTE_APPROVED
3. GET  /mobile/today       ───────▶  mobilePunch.allowedNow = true
4. take selfie + GPS
   POST /mobile/punches     ───────▶  selfie → Azure Blob
                                      punch saved, reviewStatus = PENDING
                                      (counts toward the day immediately)
                                                                    ─────▶ Remote check-ins page:
                                                                           selfie, map, time
                                                                           approve / reject
                            ◀───────  if rejected: push MOBILE_PUNCH_REJECTED,
                                      punch removed from the day
5. GET  /mobile/today       ───────▶  punches[].reviewStatus = APPROVED | REJECTED
```

Step 2 is only needed when the employee's mode is `REMOTE_DAYS`. Field staff with `ALWAYS` can check in any day.

---

## 2. Conventions

| | |
|---|---|
| **Base URL (production)** | `https://ivertovm.indiasouthcentral.cloudapp.azure.com/att/v1/mobile` |
| **Auth** | `Authorization: Bearer <Supabase access token>` on every request |
| **Body** | `Content-Type: application/json` |
| **Retries** | Send `Idempotency-Key: <uuid>` on every `POST`. A retry with the same key within 24 h returns the first response instead of punching twice. A retry while the first is still running gets `409 IDEMPOTENCY_IN_PROGRESS`; wait and retry again. |
| **Times** | Instants are UTC ISO-8601. Fields named `local` are already in the employee's site time zone; show those. |
| **Server time wins** | The punch time is the moment the server receives the request. The device clock is only stored for audit. |

**Error shape** (all endpoints):

```json
{ "statusCode": 403, "code": "MOBILE_PUNCH_NOT_ALLOWED", "message": "You have no approved remote work today" }
```

Switch on `code`, show `message`. Validation errors return `400` with `code: "VALIDATION_FAILED"` and a `details` array listing each failed field.

A login whose temporary password hasn't been changed gets `403 PASSWORD_CHANGE_REQUIRED` on every endpoint below.

---

## 3. Is this employee allowed to check in remotely?

### 3.1 `GET /me` → mode

```json
{
  "features": {
    "mobilePunch": "REMOTE_DAYS",
    "remoteWork": true
  }
}
```

| `mobilePunch` | Meaning | What the app shows |
|---|---|---|
| `NEVER` | Mobile punching is off for this employee | Hide the check-in button |
| `REMOTE_DAYS` | Allowed only on days with **approved** remote work | Check-in button + "Request remote work" |
| `ALWAYS` | Field staff: allowed any day | Check-in button |

HR sets the mode per employee in the web console.

### 3.2 `GET /today` → allowed right now?

```json
{
  "timezone": "Asia/Kolkata",
  "mobilePunch": { "mode": "REMOTE_DAYS", "allowedNow": true }
}
```

Enable the check-in button only when `allowedNow` is `true`. The server enforces the same rule anyway (`403 MOBILE_PUNCH_NOT_ALLOWED`).

---

## 4. Request remote work (only for `REMOTE_DAYS`)

### 4.1 Apply

```http
POST /v1/mobile/remote-work
Idempotency-Key: 3f2b9c1e-...
```

```json
{ "from": "2026-10-27", "to": "2026-10-28", "reason": "Client site visit, Hyderabad" }
```

| Field | Type | Rules |
|---|---|---|
| `from` | string | `YYYY-MM-DD`, required |
| `to` | string | `YYYY-MM-DD`, required, not before `from`, at most 93 days after it |
| `reason` | string | optional, ≤ 1000 characters |

**`201 Created`**

```json
{
  "id": "cmh3x0k2a0001qz8e7v1d4abc",
  "employeeId": "cmgk1...",
  "startDate": "2026-10-27",
  "endDate": "2026-10-28",
  "reason": "Client site visit, Hyderabad",
  "status": "PENDING",
  "approverId": null,
  "decidedAt": null,
  "decisionNote": null,
  "createdAt": "2026-10-26T06:10:00.000Z"
}
```

(Internal fields such as `tenantId` and `createdBy` are also returned and can be ignored.)

| Error | When |
|---|---|
| `400 BAD_RANGE` | `to` is before `from` |
| `400 RANGE_TOO_LARGE` | More than 93 days |
| `409 OVERLAP` | Overlaps another pending or approved remote-work request |
| `403 NO_EMPLOYEE` | The login isn't linked to an employee |

The employee's manager is notified. When it's decided, the employee gets a push with `type` `REMOTE_APPROVED` or `REMOTE_REJECTED` (`data.id` = request id).

### 4.2 My requests

```http
GET /v1/mobile/remote-work?cursor=&limit=20
```

```json
{
  "data": [
    { "id": "cmh3x...", "startDate": "2026-10-27", "endDate": "2026-10-28", "status": "APPROVED", "reason": "Client site visit, Hyderabad", "decisionNote": null,
      "employee": { "id": "cmgk1...", "fullName": "Asha Rao", "employeeCode": "E1042" } }
  ],
  "nextCursor": null
}
```

`status` is `PENDING`, `APPROVED`, `REJECTED` or `CANCELLED`. Pass `nextCursor` back as `cursor` for the next page (`limit` 1–100).

---

## 5. Check in / check out with a selfie

```http
POST /v1/mobile/punches
Idempotency-Key: 9a7c0d52-...
```

### 5.1 Request body

```json
{
  "direction": "in",
  "lat": 17.44812,
  "lng": 78.39167,
  "accuracy": 14.2,
  "isMockLocation": false,
  "clientTime": "2026-10-27T03:31:05.120Z",
  "selfieBase64": "/9j/4AAQSkZJRgABAQAAAQABAAD..."
}
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `direction` | string | yes | `"in"` or `"out"` |
| `lat` | number | yes | −90 … 90 |
| `lng` | number | yes | −180 … 180 |
| `accuracy` | number | yes | Metres, ≥ 0 (`Location.getAccuracy()`) |
| `isMockLocation` | boolean | no | `true` if the OS reports a mock provider. Managers see a red "Mock location" badge. |
| `clientTime` | string | no | Device time, ≤ 40 characters; stored for audit only |
| `selfieBase64` | string | yes | Base64 of a **JPEG**, at most **2 MB decoded**. No `data:image/jpeg;base64,` prefix and no line breaks. |

Unknown fields are rejected (`400 VALIDATION_FAILED`), so send only these.

### 5.2 Response `201 Created`

```json
{
  "id": "cmh40p9xq0003qz8e1k2m9xyz",
  "punchedAt": "2026-10-27T03:31:06.482Z",
  "employeeId": "cmgk1...",
  "siteId": "cmgj9...",
  "source": "MOBILE",
  "direction": "in",
  "outcome": "GRANTED",
  "lat": 17.44812,
  "lng": 78.39167,
  "accuracy": 14.2,
  "isMockLocation": false,
  "reason": "clientTime=2026-10-27T03:31:05.120Z",
  "reviewStatus": "PENDING",
  "reviewedBy": null,
  "reviewedAt": null,
  "reviewNote": null,
  "workDate": null,
  "receivedAt": "2026-10-27T03:31:06.490Z"
}
```

- The example leaves out internal fields (`tenantId`, `deviceId`, `createdBy`, …) that the app doesn't need.
- The punch **counts immediately**. Refresh `GET /today` to show the updated day.
- `workDate` is `null` in this response because it's filled in a moment later. Read the day from `/today`.
- The response also carries `photoKey` (the blob's internal key). Ignore it: the selfie can't be fetched from the mobile API.

### 5.3 Errors

| Status / `code` | When | What the app should do |
|---|---|---|
| `400 VALIDATION_FAILED` | Missing or invalid field (bad `direction`, out-of-range coordinates, `selfieBase64` not base64, extra fields) | Bug in the app: log `details` |
| `400 FILE_TYPE_MISMATCH` | Selfie isn't a JPEG (checked by its first bytes) | Re-encode as JPEG |
| `413 FILE_TOO_LARGE` | Selfie over 2 MB after decoding | Compress harder (see §6) |
| `403 MOBILE_PUNCH_NOT_ALLOWED` | Mode is `NEVER`, or `REMOTE_DAYS` without approved remote work today | Show `message`; offer "Request remote work" |
| `403 EMPLOYEE_EXITED` | Employee has left the organisation | Sign out |
| `403 NO_EMPLOYEE` | Login isn't linked to an employee | Show `message` |
| `409 IDEMPOTENCY_IN_PROGRESS` | Same `Idempotency-Key` still being processed | Retry after a second with the **same** key |
| `500 INTERNAL_ERROR` | Server-side failure (for example, the selfie store is unreachable). No punch is saved. | Keep the selfie; retry later with the **same** key |

The selfie is uploaded **before** the punch is saved, so a failed upload never leaves a punch without a photo.

---

## 6. Capturing the selfie and location (Android)

**Selfie**
- Use the **front camera**, taken in-app at the moment of check-in. Don't offer a gallery picker: the selfie is the proof of presence.
- Resize to about **720 px** on the long side and compress as JPEG at quality **80**. That gives roughly 80–200 KB, far below the 2 MB limit.
- Encode with `Base64.NO_WRAP` so there are no line breaks.

**Location**
- Ask for `ACCESS_FINE_LOCATION` and request a **fresh** fix (`getCurrentLocation` with high accuracy) rather than the last known one.
- Send `location.accuracy` as `accuracy`.
- Set `isMockLocation` from `location.isMock` (API 31+) or `location.isFromMockProvider` (older versions).

```kotlin
// Selfie → base64 JPEG
fun Bitmap.toSelfieBase64(maxSide: Int = 720, quality: Int = 80): String {
    val scale = maxSide.toFloat() / maxOf(width, height)
    val scaled = if (scale < 1f) Bitmap.createScaledBitmap(this, (width * scale).toInt(), (height * scale).toInt(), true) else this
    val out = ByteArrayOutputStream()
    scaled.compress(Bitmap.CompressFormat.JPEG, quality, out)
    return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
}

// Location → request body
@SuppressLint("MissingPermission")
suspend fun buildPunch(direction: String, selfie: Bitmap, fused: FusedLocationProviderClient): JSONObject {
    val loc = fused.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, CancellationTokenSource().token).await()
    val mock = if (Build.VERSION.SDK_INT >= 31) loc.isMock else @Suppress("DEPRECATION") loc.isFromMockProvider
    return JSONObject()
        .put("direction", direction)
        .put("lat", loc.latitude)
        .put("lng", loc.longitude)
        .put("accuracy", loc.accuracy.toDouble())
        .put("isMockLocation", mock)
        .put("clientTime", Instant.now().toString())
        .put("selfieBase64", selfie.toSelfieBase64())
}
```

Generate the `Idempotency-Key` once per check-in tap and reuse it for every retry of that tap.

---

## 7. Showing the review status

Every punch in `GET /today` and `GET /attendance/{date}` carries its review state:

```json
{
  "punches": [
    {
      "id": "cmh40p9xq0003qz8e1k2m9xyz",
      "punchedAt": "2026-10-27T03:31:06.482Z",
      "local": "2026-10-27 09:01:06",
      "offset": "+05:30",
      "timezone": "Asia/Kolkata",
      "source": "MOBILE",
      "direction": "in",
      "outcome": "GRANTED",
      "lat": 17.44812,
      "lng": 78.39167,
      "accuracy": 14.2,
      "isMockLocation": false,
      "hasPhoto": true,
      "reviewStatus": "PENDING",
      "reviewNote": null,
      "reviewedAt": null,
      "device": null
    }
  ]
}
```

| `reviewStatus` | `outcome` | Counts toward the day? | Suggested UI |
|---|---|---|---|
| `PENDING` | `GRANTED` | Yes | "Awaiting review" chip |
| `APPROVED` | `GRANTED` | Yes | "Approved" chip |
| `REJECTED` | `DENIED` | **No**; the day is recalculated without it | Struck-through time, "Rejected" chip, show `reviewNote` |
| `null` | — | — | Not a mobile check-in (terminal, correction or manual punch) |

---

## 8. Rejection notification

When a manager rejects a check-in, the employee gets an inbox entry and an FCM push.

**Push** (`data` payload):

```json
{ "type": "MOBILE_PUNCH_REJECTED", "id": "cmh40p9xq0003qz8e1k2m9xyz", "notificationId": "cmh41..." }
```

**Inbox** (`GET /notifications`):

```json
{
  "id": "cmh41...",
  "type": "MOBILE_PUNCH_REJECTED",
  "title": "Check-in rejected",
  "body": "Your mobile check-in at 2026-10-27 09:01 was rejected: Selfie does not show the employee",
  "data": { "id": "cmh40p9xq0003qz8e1k2m9xyz" },
  "readAt": null,
  "createdAt": "2026-10-27T05:12:40.000Z"
}
```

On tap, open the day of that punch and refresh it. Approvals send no notification; the chip in §7 updates on the next refresh.

---

## 9. Manager side (web, for reference)

Managers, HR and admins review check-ins on **Time off → Remote check-ins** in the web console (`/remote-work/check-ins`). Each row shows the selfie, a map of the location, the time and any mock-location warning. Managers see their direct reports and the members of departments they head; HR and admins see the whole organisation. Only admins can review their own check-in.

These endpoints are web-only today. The mobile approvals queue (`GET /mobile/approvals`) doesn't include check-ins yet.

| Endpoint | Body | Notes |
|---|---|---|
| `GET /v1/remote-work/punches?status=PENDING&employeeId=&from=&to=&cursor=&limit=` | — | Newest first; each row adds `selfieUrl`, a read-only link valid for 1 hour |
| `POST /v1/remote-work/punches/{id}/approve` | `{ "note"?: string }` | Only `PENDING` check-ins (`409 ALREADY_DECIDED` otherwise) |
| `POST /v1/remote-work/punches/{id}/reject` | `{ "note": string }` (required) | Sets `outcome: DENIED`, recalculates the day, notifies the employee |

---

## 10. Quick test with curl

```bash
TOKEN="<employee access token>"
B64=$(base64 -w0 selfie.jpg)
curl -sS -X POST "https://ivertovm.indiasouthcentral.cloudapp.azure.com/att/v1/mobile/punches" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"direction\":\"in\",\"lat\":17.44812,\"lng\":78.39167,\"accuracy\":14,\"isMockLocation\":false,\"selfieBase64\":\"$B64\"}"
```

Expect `201` with `"reviewStatus": "PENDING"`, then check that the row appears on the web **Remote check-ins** page.
