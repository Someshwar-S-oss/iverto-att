# FCM Push — Server-Side Changes (Iverto Attendance)

What the attendance API (`apps/api`, NestJS) needs so the mobile app's push notifications work end to end.
The app side is done (app v1.0.2, versionCode 3). This document is the contract the server has to meet.

Related: `mobile_api.md` §3 (push-devices + inbox routes), `ARCHITECTURE.md` §3 (Push via `firebase-admin`, NoOp when unset).

---

## 1. Summary — what to do

| # | Change | Where |
|---|---|---|
| 1 | Create a service-account key for Firebase project **`iverto-attend`** and set `FIREBASE_SERVICE_ACCOUNT` in every API/worker environment | Firebase console, deployment secrets |
| 2 | Make `POST /v1/mobile/push-devices` an **upsert keyed on the token** that re-assigns the token to the caller | `mobile/` controller + `notifications/` service |
| 3 | Make `DELETE /v1/mobile/push-devices/:token` **idempotent**, and allowed while `must_change_password` is set | same |
| 4 | Send **notification + data** messages with `channelId: "default"` and the data keys in §5 (strings only) | `notifications/` FCM provider |
| 5 | Use the **notification `type` names** in §6. The app routes taps by them | everywhere a notification is created |
| 6 | **Prune dead tokens** from FCM responses and retry transient failures through the queue | FCM provider / BullMQ job |
| 7 | (Console) Add the SHA fingerprints in §10 to the Firebase Android app | Firebase console |

---

## 2. Firebase project

| Field | Value |
|---|---|
| Project ID | `iverto-attend` |
| Project number / Sender ID | `384570957165` |
| Android app ID | `1:384570957165:android:bad50e79d40cab68d18e64` |
| Android package | `com.iverto.attendance` |

The app's tokens are issued for this project only. A service account from any other project fails
every send with `messaging/mismatched-credential` (SENDER_ID_MISMATCH).

### 2.1 Credentials

1. Firebase console → **Project settings → Service accounts → Generate new private key** (for `iverto-attend`).
2. Store the JSON in the secret store and expose it as `FIREBASE_SERVICE_ACCOUNT` to **both** the API process and
   the BullMQ worker processes (whichever one actually calls FCM).
3. Never commit it, and never put it in the mobile app.
4. **Firebase Cloud Messaging API (V1)** must show *Enabled* under Project settings → Cloud Messaging. The legacy
   HTTP API / "server key" (`fcm.googleapis.com/fcm/send`) has been shut down. `firebase-admin` uses V1, so nothing
   else is needed.

**Pitfall:** a raw service-account JSON pasted into an env var often breaks the `\n` escapes in `private_key`
("Invalid PEM formatted message"). Base64-encode the whole file, or point the variable at a file path, and decode
it in the provider:

```ts
import { cert, getApps, initializeApp } from 'firebase-admin/app';

function firebaseCredential() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;                                   // → NoOp provider, as today
  const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const sa = JSON.parse(json);
  if (sa.project_id !== 'iverto-attend') {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT is for ${sa.project_id}, expected iverto-attend`);
  }
  return cert(sa);
}

const credential = firebaseCredential();
const app = credential ? (getApps()[0] ?? initializeApp({ credential })) : null;
```

Log once at boot which provider is active (`push: FCM (iverto-attend)` / `push: NoOp`). An environment
without the secret otherwise drops every push silently.

---

## 3. `push_devices` table

```sql
create table push_devices (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  user_id       uuid not null,            -- Supabase auth user id (JWT sub)
  token         text not null,            -- raw FCM registration token
  platform      text not null check (platform in ('android', 'ios')),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create unique index push_devices_token_key on push_devices (token);
create index push_devices_user_idx on push_devices (tenant_id, user_id);
```

- `token` is **globally unique**: one phone = one token = one current owner.
- **RLS caveat:** under the tenant-isolation policy, a token row owned by *another tenant* is invisible. An
  upsert from the new tenant then fails with a unique violation it cannot see. Run the "remove this token from
  whoever had it" step through the privileged (BYPASSRLS / service) connection, or wrap it in a
  `SECURITY DEFINER` function.
- Optional housekeeping: delete rows whose `last_seen_at` is older than **270 days**. FCM expires inactive tokens
  after that; the app refreshes `last_seen_at` on every launch.

---

## 4. Routes

### 4.1 `POST /v1/mobile/push-devices`

```json
{ "token": "<FCM registration token>", "platform": "android" }
```
→ `200 { "status": "registered" }`

When the app calls it:
- after sign-in, and **on every app launch while signed in**, once the user has granted the notification permission
  (Android 13+ asks at runtime). That includes the first launch after someone turns notifications back on in
  Settings.
- whenever FCM rotates the token on the device.

Server behaviour:
1. Validate: `token` is a string of 1–4096 chars, `platform` is in `['android', 'ios']`. Only `android` is sent today.
2. **Upsert on `token`:** if the row exists, set `tenant_id`, `user_id` and `platform` to the caller's, and bump
   `last_seen_at`. If it doesn't exist, insert it. A token that belonged to someone else, such as a shared or
   handed-over phone, **moves** to the caller, so the previous owner stops getting pushes on that device.
3. Do **not** require `Idempotency-Key`; the app sends none on this route, and the upsert is naturally idempotent.
4. Normal rate limit applies (one call per launch is far under 120/min).

### 4.2 `DELETE /v1/mobile/push-devices/:token`

→ `200 { "status": "unregistered" }` (or `204`)

When the app calls it:
- on **sign-out**, *before* the Supabase sign-out, so the access token is still valid. The client gives it
  **5 seconds**, then signs out anyway.
- for the **previous** token after FCM rotated it.

Server behaviour:
1. The token arrives URL-encoded (`encodeURIComponent`). FCM tokens contain `:`, so check that the route param is
   decoded and the router doesn't split on it.
2. Delete `where token = :token and user_id = <caller>`.
3. Return success **even when nothing matched**. The client ignores the result; a 404 only makes noise.
4. **Allow this route while `must_change_password` is set.** It belongs in the same allowlist as `/me` and `/password`,
   because the forced-password-change screen has its own Sign-out button.

### 4.3 What happens when the app cannot call DELETE

If the session has already expired (refresh token refused) or the phone is offline at sign-out, the app
**deletes the FCM token on the device** instead (`FirebaseMessaging.deleteToken`). The server's copy is then
dead, and the next send returns `registration-token-not-registered`. §7 must prune it, or the previous user's
row stays forever.

---

## 5. Message format

Send **notification + data** messages, not data-only. Android draws notification messages itself while the app is
in the background or killed. That keeps working under Doze and needs no app code to wake. When the app is
open, it shows them as a banner too.

```ts
import { getMessaging, MulticastMessage } from 'firebase-admin/messaging';

const message: MulticastMessage = {
  tokens,                                    // ≤ 500 per call, see §7
  notification: {
    title: n.title,                          // same text as the inbox row
    body: n.body,
  },
  data: toFcmData(n),                        // §5.1, string values only
  android: {
    priority: 'high',
    ttl: ttlFor(n.type),                     // milliseconds in firebase-admin, see §5.2
    notification: {
      channelId: 'default',                  // the only channel the app creates
      tag: n.id,                             // a retried send replaces, never duplicates
    },
  },
};
```

Leave `android.notification.icon` / `color` **unset**. The app ships a default icon (white Iverto mark) and
colour (`#B9000E`) in its manifest. If you do set `icon`, it must be the resource name `notification_icon`.
Any other value renders as a blank square.

### 5.1 Data keys

FCM data values **must be strings** (`firebase-admin` throws on numbers, booleans and objects). Total payload
must be under 4 KB.

| Key | Required | Value | Used for |
|---|---|---|---|
| `type` | yes | Same string as the inbox row's `type`, e.g. `LEAVE_APPROVED` (§6) | Deciding which screen opens |
| `notificationId` | yes | The `app_notifications.id` of the matching inbox row | Linking the push to the inbox row (future mark-read on tap) |
| `id` | for request notifications | The leave / correction / remote-work **request id**, the same `id` the request lists return | Opens that request |
| `date` | for day notifications | `YYYY-MM-DD` work date | Opens that day |

```ts
function toFcmData(n: { id: string; type: string; data?: Record<string, unknown> | null }): Record<string, string> {
  const out: Record<string, string> = { notificationId: n.id, type: n.type };
  const id = n.data?.id;
  if (id != null) out.id = String(id);
  const date = n.data?.date;
  if (typeof date === 'string') out.date = date.slice(0, 10);
  return out;
}
```

**Do not use these keys in `data`:** `body`, `title`, `message`, `sound`, `vibrate`, `sticky`, `channelId`,
`subtitle`, `badge`, `priority`, `color`, `icon`. The app's notification library (`expo-notifications`) treats them as
Expo-push presentation fields. In particular, a `data.body` holding a JSON string hides every other data key from
the app. Reserved by FCM itself: `from`, `notification`, `message_type`, and anything starting with `google.` or
`gcm.`.

The app also accepts a single `data` key containing the inbox row's `data` object as a JSON string, and merges it
over the flat keys. Flat keys are preferred.

### 5.2 TTL

| Kind | Suggested `ttl` |
|---|---|
| Approval requests to managers | 3 days |
| Request outcomes to employees | 3 days |
| Missed-punch / late reminders | 12 hours (pointless the next day) |
| Report ready, device offline | 1 day |

---

## 6. Notification types and where a tap goes

The app routes a tapped push with the **same rules as a tapped inbox row** (`lib/requests.ts` →
`notificationTarget`):

1. If `type` **starts with** `LEAVE`, `CORRECTION` or `REMOTE`, or **contains** `MISSED_PUNCH`, and `id` is present
   → opens request `id` of that kind.
   - If, in addition, the reader is a manager/HR/admin and the type **contains** `REQUESTED|SUBMITTED|PENDING|NEW|APPROVAL`
     and **doesn't end** in `APPROVED|REJECTED|CANCELLED`, the request opens in the **approver view**
     (approve / reject buttons).
2. Otherwise, if `date` is present → opens that **day**.
3. Otherwise → opens the **inbox**.

So the type names below matter. Use them as-is (or keep to the same prefixes and suffixes):

| Recipient | `type` | Data | Opens |
|---|---|---|---|
| Approver (manager, HR fallback) | `LEAVE_SUBMITTED` | `id` = leave request id | Request, approver view |
| Approver | `CORRECTION_SUBMITTED` | `id` = correction id | Request, approver view |
| Approver | `REMOTE_SUBMITTED` | `id` = remote-work request id | Request, approver view |
| Employee | `LEAVE_APPROVED` / `LEAVE_REJECTED` / `LEAVE_CANCELLED` | `id` | Request |
| Employee | `CORRECTION_APPROVED` / `CORRECTION_REJECTED` | `id` | Request |
| Employee | `REMOTE_APPROVED` / `REMOTE_REJECTED` | `id` | Request |
| Employee | `MISSED_PUNCH` | **`date` only, no `id`** | Day (where they can raise a correction) |
| Employee | `ROSTER_CHANGED` / `SHIFT_CHANGED` | `date` | Day |
| Employee | `LATE_MARKED` / `ABSENT_MARKED` | `date` | Day |
| HR / admin | `REPORT_READY` | (none needed) | Inbox |
| Admin | `DEVICE_OFFLINE` | (none needed) | Inbox |

Watch out for:
- **`MISSED_PUNCH` must not carry `id`.** With an `id` the app treats it as an existing correction request and
  tries to open one.
- A request outcome sent to the employee must **not** contain `SUBMITTED` / `PENDING` / `NEW` in its type.
  Otherwise a manager reading their *own* outcome opens it in approver view.
- The inbox icon is picked from the same names (`…APPROVED` ✓, `…REJECTED` ✕, `SHIFT`/`ROSTER` calendar,
  `LATE`/`MISSED`/`ABSENT` alarm, `REPORT` chart, `DEVICE` chip).

### 6.1 Inbox first, push second

For every event:
1. Insert the `app_notifications` row (the inbox is the source of truth).
2. Enqueue the push job with that row's `id`, so `notificationId` and `tag` are set.
3. Push to **all** of the recipient's `push_devices` rows in the recipient's tenant.

A failed push never rolls back the inbox row or the business action, such as an approval.

---

## 7. Sending, failures and token pruning

Send from a BullMQ job so an approval request never waits on FCM.

```ts
const DEAD = new Set([
  'messaging/registration-token-not-registered',   // uninstalled, signed out, or deleteToken() on device
  'messaging/invalid-registration-token',
  'messaging/mismatched-credential',               // token from another Firebase project; log loudly
]);
const RETRY = new Set([
  'messaging/unavailable',
  'messaging/internal-error',
  'messaging/server-unavailable',
  'messaging/quota-exceeded',
  'messaging/message-rate-exceeded',
]);

async function sendToTokens(base: Omit<MulticastMessage, 'tokens'>, tokens: string[]) {
  const retry: string[] = [];
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const res = await getMessaging(app!).sendEachForMulticast({ ...base, tokens: chunk });
    const dead: string[] = [];
    res.responses.forEach((r, j) => {
      if (r.success) return;
      const code = r.error?.code ?? '';
      if (DEAD.has(code)) dead.push(chunk[j]);
      else if (RETRY.has(code)) retry.push(chunk[j]);
      else logger.warn({ code, msg: r.error?.message }, 'push failed');   // e.g. invalid-argument = payload bug
    });
    if (dead.length) await privilegedDb.pushDevice.deleteMany({ where: { token: { in: dead } } });
  }
  // Throw so BullMQ retries with backoff, for the failed tokens only (put them in the job data).
  if (retry.length) throw new RetryablePushError(retry);
}
```

- Use `send` / `sendEach` / `sendEachForMulticast`. The legacy `sendToDevice`, `sendMulticast` and
  `sendAll` are deprecated or removed in current `firebase-admin`.
- Retries reuse the same `android.notification.tag`, so a retried notification replaces the first rather than
  stacking.
- `messaging/invalid-argument` is usually a payload problem (non-string data value, oversized payload). Don't
  prune on it; fix the payload.

---

## 8. What the app does (for reference)

- **Platform:** Android only for now. The app registers the raw **FCM token** from
  `getDevicePushTokenAsync()`. It is *not* an Expo push token (`ExponentPushToken[…]`), so don't route through
  Expo's push service. iOS would need the Firebase iOS SDK and an APNs key uploaded to Firebase first. Until
  then the app doesn't register on iOS.
- **Permission:** asked after sign-in on Android 13+. If refused, the app doesn't register (no row server-side).
- **Channel:** `default`, named *"Attendance updates"*, high importance. The manifest's FCM default channel is also
  `default`, so a message without `channelId` still lands there.
- **Foreground:** shown as a banner with sound.
- **Tap:** routed by §6, including a tap that launches the app cold, or one made while signed out (it waits for
  sign-in).
- **Sign-out:** `DELETE` (5 s budget) → delete the FCM token on the device → clear the tray. On session expiry:
  delete the token on the device only (§4.3).
- **Builds:** target/compile SDK 36 (Android 16), min SDK 24. The Play build is an AAB signed with the upload
  key and re-signed by Google Play App Signing.

---

## 9. Testing

1. Install the Play-internal-testing build (or a release APK built with `google-services.json`), sign in and
   allow notifications.
2. Confirm a `push_devices` row for that user, with `platform = 'android'`.
3. Send a test from the server:
   ```ts
   await getMessaging(app!).send({
     token: '<token from push_devices>',
     notification: { title: 'Leave approved', body: 'Your leave for 10 Apr has been approved.' },
     data: { type: 'LEAVE_APPROVED', id: '<a real leave request id of that user>', notificationId: 'test-1' },
     android: { priority: 'high', notification: { channelId: 'default', tag: 'test-1' } },
   });
   ```
   Or use Firebase console → Messaging → *New campaign* → *Notifications* → **Send test message** with the token.
   (The console can't set every field.)
4. Check all three states: app **open** (banner), **background** (tray), **swiped away / killed** (tray). Tapping
   each must open the leave request.
5. Send `MISSED_PUNCH` with `date` → the tap opens that day. Send `REPORT_READY` → the tap opens the inbox.
6. Sign out → the row is gone. Send again to the old token → `registration-token-not-registered` → no error spam.
7. Sign in as **another user on the same phone** → the same token's row now belongs to the new user (§4.1 step 2).

---

## 10. Firebase console — signing fingerprints

FCM itself **doesn't use** SHA fingerprints. They are needed if Google Sign-In, App Check or Phone Auth are
ever added. Add them now to **Project settings → Your apps → com.iverto.attendance → SHA certificate
fingerprints** so the Android app is fully registered:

| Key | SHA-1 | SHA-256 |
|---|---|---|
| Play **app signing** key (Google-held; what users' installs are signed with) | `F8:BD:10:21:D2:E4:7D:95:28:C3:5D:2A:1C:1A:BE:9C:4E:4F:82:6C` | `4F:5A:B1:E4:3E:15:F7:5F:52:3F:49:8E:1D:44:35:CB:31:AF:18:E8:15:4D:46:D5:FA:A7:78:BF:F0:AD:D4:63` |
| **Upload** key (`iverto-upload`; signs the AAB and sideloaded APKs) | `89:A5:E7:60:75:A3:1A:DE:5D:FF:AA:B0:68:50:2C:6C:5C:D3:82:16` | `AE:A8:98:81:D4:FE:1B:31:6A:17:BF:5F:3E:19:51:EF:78:E0:60:73:52:98:40:C5:B0:F6:6C:99:55:84:41:A1` |

Optional hardening: the `api_key` in `google-services.json` ships inside the app and isn't a secret. It can be
restricted in Google Cloud console → *APIs & Services → Credentials* to **Android apps** `com.iverto.attendance`
with **both** SHA-1s above. Restrict it to the Firebase Installations and FCM Registration APIs. Restricting it with the
wrong fingerprint stops every device from getting a token, so test a Play-installed build straight after.

---

## 11. Checklist

- [ ] `FIREBASE_SERVICE_ACCOUNT` (project `iverto-attend`) set for API **and** workers in every environment; boot log
      shows `push: FCM`
- [ ] FCM API (V1) enabled
- [ ] `push_devices.token` unique; register = upsert that re-assigns the owner; RLS-safe
- [ ] `DELETE /push-devices/:token` idempotent, decodes `:`, allowed during forced password change
- [ ] Messages: `notification` + string-only `data` (`type`, `notificationId`, `id` | `date`), `channelId: "default"`,
      `tag` = notification id, no icon override
- [ ] Type names follow §6; `MISSED_PUNCH` has `date`, no `id`
- [ ] Inbox row written before the push; push failure never fails the action
- [ ] Dead tokens pruned; transient errors retried via BullMQ
- [ ] SHA fingerprints added in Firebase console
- [ ] End-to-end test (§9) passed on a Play-installed build
