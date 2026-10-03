# M50 Biometric Terminal Integration

Face/attendance terminals (serials like `DJ20250307014`) that report scans to the
hostel cloud. Protocol reference: [`websocket_sdk_protocol.txt`](./websocket_sdk_protocol.txt),
extracted from the vendor's *M50 WebSocket SDK Communication Protocol* document.

## How it differs from our own edge devices

| | Python edge agent | M50 terminal |
|---|---|---|
| Transport | Socket.IO, namespace `/ws` | raw WebSocket, path `/m50` |
| Payload | JSON | XML |
| Auth | Ed25519 device JWT | SDK `Register`/`Login` token |
| Matching | insightface, `vector(512)` embeddings | on-device, opaque vendor template |
| Direction | reported per event | inferred from gate mounting |

The two cannot share a listener: Socket.IO's handshake framing is not plain
WebSocket, so the terminal gets its own `ws` server (`M50Server`) attached to the
same HTTP port in `main.ts`.

### Who owns the `upgrade` event

Both stacks listen for `upgrade` on the one HTTP server, so ownership is
explicit rather than incidental:

- `SharedHttpIoAdapter` disables Engine.IO's `destroyUpgrade`. By default it
  reaps any upgrade it does not recognise after ~1s unless bytes have already
  been written. Terminal sockets survive that only because the handshake
  answers in time — fine until a load spike delays it, then terminals drop for
  no visible reason.
- `M50Server` takes over the reaping: it claims `M50_WS_PATH`, and destroys any
  upgrade still unanswered after 1s so unrouted paths cannot leak half-open
  sockets.

`m50.server.spec.ts` asserts this end to end with a real `ws` client against a
real Socket.IO server, including that a terminal outlives the reaper window.

Everything downstream **is** shared. Terminal scans are enqueued onto the
existing `auth-event-ingest` queue in the shape `EventsProcessor` already
consumes, so they become `AuthEvent` rows and inherit permission exit/return
linking, curfew evaluation and the live dashboard broadcast with no changes to
that processor.

## Bringing a terminal online

1. **Provision the serial first.**

   ```
   POST /v1/tenants/{tenantId}/terminals
   { "serialNo": "DJ20250307014", "siteId": "...", "name": "Main gate — entry",
     "gateDirection": "in" }
   ```

   This is a security gate, not bookkeeping. The vendor's reference server issues
   a token to *any* device that asks; we refuse to mint one for a serial we have
   not been told about, because the `SiteDevice` row is what binds the terminal
   to a tenant and site.

2. **Point the device at us.** In the terminal's menu set the WebSocket server
   URL to `wss://<host>/hostel/m50`.

   **Set `M50_WS_PATH` to match what the app actually receives.** Whether the
   `/hostel` segment reaches the app is a deployment question, and the answer
   differs between environments — compare with `API_PREFIX`, which solves the
   same problem for HTTP routes:

   | `API_PREFIX` | Proxy behaviour | `M50_WS_PATH` |
   |---|---|---|
   | `hostel/v1` | forwards the path unchanged | `/hostel/m50` |
   | `v1` | strips `/hostel` before forwarding | `/m50` (default) |

   Getting this wrong fails in a way that does not look like a path problem: see
   the 502 row in Troubleshooting. The device retries every 10s until it connects.

3. **Optionally set `M50_CLOUD_ID`** to a shared secret and configure the same
   value on the device, for a second check during `Register`.

The device then registers (receiving a token we persist), logs in with it on
every reconnect, and starts streaming. On login the server walks
`GetGlogPosInfo` → `GetFirstGlog` → `GetNextGlog` from the stored cursor to
recover anything buffered while it was offline.

## Testing without the hardware

`scripts/m50-simulator.ts` impersonates a terminal on the real wire protocol.
Use it to prove the server end works before the device arrives — and, when the
device is present but silent, to establish which end is at fault.

```bash
npm run m50:simulate -- --url ws://localhost:8031/m50 --serial DJ20250307014 --user 2
npm run m50:simulate -- --serial DJ20250307014 --scan-interval 10   # keep scanning
npm run m50:simulate -- --stay                                      # answer commands, stay up
npm run m50:simulate -- --preload 3 --stay        # device already holds users 1-3
npm run m50:simulate -- --admin-log EnrollUserFP --admin-user 2     # emit an AdminLog_v2
```

It prints every frame in both directions, so a refused `Register` or a
`FailUnknownToken` is visible immediately.

It also answers server-initiated commands from an in-memory user table, so
enrolment, template capture, `device/users` and `device/logs` can all be
exercised end to end. Two knobs matter:

- `--preload N` seeds slots the cloud has no mapping for, which is the state a
  commissioned terminal actually arrives in. Provisioning against it is how you
  reproduce — and now verify the guard against — an enrolment landing on top of
  an existing person. The simulator prints a loud `!!` line when a `SetUserData`
  overwrites an occupied slot.
- `--remote-enroll-result` defaults to `EnrollNumberError`, matching real
  hardware; pass `Success` to exercise the accepted path.
- `--keypad-enroll N` simulates N enrolments done at the device menu: the
  simulator picks the numbers itself and announces them only through
  `AdminLog_v2`, exactly as the firmware does. Those slots then appear in
  `GET device/unclaimed`, complete with retrievable photos, so the whole claim
  workflow can be walked through without anybody standing at a terminal.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing in the log at all | The device never reached us. Check the URL in its menu, then that Caddy proxies `/hostel/m50` with `Connection: Upgrade` preserved. The device retries every 10s and reports nothing on failure. |
| Proxy returns **502** to an upgrade, but a plain `GET` of the same URL returns a Nest **404** | `M50_WS_PATH` does not match the path the app receives. The two requests take different routes through the app: the GET reaches Nest and 404s honestly, while the upgrade matches no path, goes unclaimed, and is destroyed by the reaper after 1s — which the proxy reports as a dead upstream. Compare the startup line `M50 terminal server listening on <path>` against the path in the 404 body, which is the URL the app actually saw. |
| `Register rejected for unknown serial` | The serial was not provisioned. Create the terminal first — we do not self-provision. |
| `Register rejected … CloudId mismatch` | `M50_CLOUD_ID` is set server-side and differs from the device's. |
| Login loops with `FailUnknownToken` | The stored token was rotated. Expected: the device should re-`Register` on its own and recover. |
| Scans arrive as `subjectType: UNKNOWN` | No `TerminalUser` mapping — usually someone enrolled at the keypad instead of through the API. `GET device/unclaimed` lists them; bind each with `POST users/{slot}/claim`. Scans already recorded stay UNKNOWN. |
| A student stays **Awaiting face** after enrolling at the terminal | We were not told. Press *Check the device* (`POST device/sync-enrolment`), which reads the hardware's own `FaceEnrolled` flag. If the sync reports the slot in `unmapped` instead, they enrolled into a *new* number rather than the reserved one — bind that number from the queue and release the empty reservation. |
| A student shows as enrolled but the gate does not recognise them | The face was deleted at the keypad. A sync moves them back to *Awaiting face*; `missingOnDevice` means the whole record is gone from the terminal. |
| A scan is on the device but never reached gate activity | The backfill cursor and the seek position disagreed — see *Position is not LogID*. Confirm with `GET device/logs` (which reads from position 0) against the same window in gate activity; the fix is in the resume search, and the record is picked up on the next reconnect. |
| Everyone shows the wrong direction | `gateDirection` is unset or backwards on that device record. |
| A scan is attributed to the wrong person | The slot was written over. `GET device/users` — a `nameMismatch` or an `unmappedOnDevice` neighbour is the confirmation. Historic rows in `device/logs` carrying `attributionSuspect: true` are named with a mapping that postdates the scan. |
| Remote enrolment appears to do nothing | Expected: `RemoteEnroll` carries no `UserID` and hardware answers `EnrollNumberError`. Read the `resultCode` in the 200 response. Even a `Success` only means the device is *waiting* — watch `device/admin-logs?category=enrollment`. |
| Timestamps off by hours | The terminal's clock is not on site time; set `M50_CLOCK_TZ` or fix the device clock. |

## Position is not LogID

The glog has two numbering schemes and no command that converts between them.

- **Position** is a 0-based offset into the device's ring. It is what
  `BeginLogPos` means, in `GetFirstGlog` and `GetNextGlog` alike.
- **LogID** is the device's own monotonic counter, carried inside each record.
  It is what we store as the ingest cursor, because it is the only one that
  stays meaningful after the ring is trimmed.

They line up exactly on a terminal whose log has never been trimmed, which is
what makes conflating them so easy and so quietly destructive. Backfill used to
resume at `lastLogId + 1` as though it were a position; on a device holding 37
records with the cursor at LogID 36 that seeks to position 37, which does not
exist. The device answers `Fail` — the same answer it gives for "nothing new" —
so the newest scan was never read, and because the cursor never advanced past
it, never would be. It showed up as an entry visible in `device/logs` (which
reads positions from 0) that had no matching row in the gate activity.

The resume point is now searched for rather than derived: LogIDs ascend with
position, so a binary search over `[0, LogCount - 1]` finds the first record
newer than the cursor in about seventeen reads on a hundred-thousand-record
device. Inside the walk, the position is counted locally and `GetNextGlog` is
given that, never `logId + 1`. The per-record `logId <= lastLogId` guard stays
as a backstop, so reading too much is free and reading too little is what the
design refuses to risk.

The same applies to the `device/logs` viewer: its `from` and `nextFrom` are
positions, not LogIDs.

## Direction is decided by the gate, not the device

`AttendStat` is nominally the travel indicator, but in practice the terminal
reports whatever mode it is parked in — every row in the commissioning sample
read `DutyOff`, including entries. Trusting it would mark every scan at an entry
gate as an exit.

So `gateDirection` on the device record is authoritative, and `AttendStat`
overrides it only when it carries an unambiguous `In`/`Out`. A bidirectional
doorway therefore needs two terminals, one per direction.

### Which means a scan is not a movement

The direct consequence: the exit terminal reports `out` for every face it reads,
including somebody who is already outside and presented again because the beep
was not obvious. Observed in the field as four consecutive `out` records for one
student, 69 and 109 seconds apart — too far apart for any debounce window to
help, and each one a distinct device `LogID`, so both dedupes upstream (the
BullMQ `jobId` and the processor's `frameKey` check) legitimately pass it.

`SubjectPresence` is what settles it: one row per person, holding `state`,
`since` and `lastEventAt`. `PresenceService.recordScan` applies the movement as
a single conditional UPDATE —

```
WHERE subject_id = $1 AND state <> $new AND last_event_at < $ts
```

— which is required rather than stylistic. The two gates are separate
connections whose scans are processed concurrently by BullMQ workers, so
read-then-write loses updates: both workers read `in`, both write. Exactly one
of two concurrent conditional updates can match.

Zero rows updated means the scan moved nobody, and then:

- the `AuthEvent` is still written, flagged `isMovement = false`, and still
  broadcast — the device really did read that face, and Gate Activity dims the
  row rather than hiding it, because seeing who double-scans is how a badly
  placed terminal gets noticed;
- permission exit/return linking and curfew evaluation are **skipped**. Both
  were previously driven by the raw scan, which meant a stray entry 15 seconds
  after an exit closed a running permission with `durationMinutes: 0`, and a
  repeated late-night entry raised one curfew violation and one parent message
  per scan (violations dedupe on `authEventId`, and a repeat is a different
  event).

The `last_event_at` guard is also what makes glog backfill safe: a replayed log
is recorded as history without rewriting the present.

Presence can still get stuck — walk in behind somebody without presenting a face
and the hardware never sees the entry, so the next exit is refused as a repeat.
`PUT /v1/tenants/{t}/presence/students/{id}` corrects it, audited as
`PRESENCE_OVERRIDE` and stamped on the row so a correction is never mistaken for
an observation.

## Identity mapping

The terminal knows people only as integers 1–99999999. `TerminalUser` maps
`(deviceId, terminalUserId)` to a subject, and the cloud allocates the number at
enrollment. `UserID 0` is the terminal administrator, not a person.

A scan with no mapping is still recorded, as `subjectType: UNKNOWN` — an
unattributable entry is evidence, and it surfaces terminals that have drifted
out of sync (typically because someone enrolled or deleted a user at the keypad;
`AdminLog_v2` enrolment and deletion events are logged loudly for this reason).

### The slot number is the whole identity, so allocation has to be careful

A device slot is not a name — it is a number the hardware reuses without
comment. Two consequences follow, and both have produced auth logs naming the
wrong person:

**Allocating from our own table is not enough.** A terminal that was
commissioned before the cloud existed, or that anyone has ever used the keypad
on, holds users we have no row for. `max(ours) + 1` then lands on an occupied
number: `SetUserData` overwrites that person's *name*, but the face already in
the slot survives. The original person keeps opening the gate, the device keeps
reporting their old `UserID`, and we attribute every one of those scans to
whoever we just wrote in. Allocation therefore probes the candidate slot with
`GetUserData` first, and walks `GetFirstUserData`/`GetNextUserData` for the
device's true high-water mark when the probe comes back occupied.

**The reservation has to precede the device write.** Two concurrent enrolments
can compute the same free number. Writing the device first means both write
their name into that slot and only then does the unique index reject the loser —
leaving the hardware holding the loser's name and face under a number we have
mapped to the winner. So the `TerminalUser` row is created first and released if
the device refuses.

`GET :deviceId/device/users` diffs both sides and is the way to find out whether
this has already happened. Read `summary.unmappedOnDevice` first (slots the
hardware has and we cannot name) and `summary.nameMismatch` second (both sides
hold the slot under different names — the signature of an overwrite).

### Historical attribution is best-effort by construction

`AuthEvent` resolves the subject once, at ingest, and stores it — those rows are
a snapshot and stay correct. The device-log viewer cannot do that: the terminal
stores only the number, so `GET :deviceId/device/logs` attributes with *today's*
mapping. When a scan predates the mapping used to name it, the record is flagged
`attributionSuspect: true` rather than quietly showing the current occupant. A
disagreement between that view and the auth event list for the same `LogID`
means the slot changed hands in between.

## Face templates

`GetFaceData` returns an **opaque vendor template**, not an embedding. It is
stored in `TerminalFaceTemplate`, deliberately separate from
`FaceEnrollment.embedding`, which is a `vector(512)` insightface embedding for
our own pipeline. The two are not interchangeable and must never be conflated.

Storing them centrally means a face enrolled once at any gate can be pushed onto
every other terminal without the subject present:

```
POST /v1/tenants/{t}/terminals/{deviceId}/enroll/photo       # enrol from a stored JPEG (<32KB)
POST /v1/tenants/{t}/terminals/{deviceId}/templates/capture   # harvest into the cloud
POST /v1/tenants/{t}/terminals/{deviceId}/templates/replicate # push onto another gate
```

### The photo does not ride along with the template

`SetFaceData` carries the matching template and nothing a human can look at, so
a gate that received a face by replication recognises the person perfectly well
and answers `GetUserPhoto` with `Fail`. Only the terminal somebody physically
enrolled at ends up holding a photograph of them, and `TerminalFaceTemplate`
stores the template alone — the picture lives on the hardware or nowhere.

Two things close that gap, both best-effort by design, because losing a picture
must never roll back a face that is already on the device and working:

- `enroll/photo` follows `EnrollFaceByPhoto` with `SetUserPhoto` carrying the
  same JPEG. Whether the firmware would otherwise retain it is a device setting
  we do not control, so it is set explicitly.
- `templates/replicate` reads the photo back off the source terminal and writes
  it onto the target. This needs the source online — there is nowhere else to
  read it from — and is skipped silently when it is not.

Neither is retroactive. Gates populated by replication before this existed still
hold no photo, and the terminal the person enrolled at is the one to ask. That
is what the Face Enrollment page does: it walks the student's gates, source
terminal first, and shows the first picture that comes back.

### Moving templates in bulk

The per-device endpoints above are the primitives, and they are the wrong shape
for the two things operators actually do. Both are a *set of people* and a *set
of gates*, so that is what the bulk endpoints take:

```
GET  /v1/tenants/{t}/terminals/templates/coverage    # who has a template, who is on which gate
POST /v1/tenants/{t}/terminals/templates/capture     # harvest many subjects off one terminal
POST /v1/tenants/{t}/terminals/templates/distribute  # push many subjects onto many terminals
```

`coverage` is answered entirely from `TerminalUser` and `TerminalFaceTemplate` —
no device round trips — because it is the view used to *choose* what to move, and
a matrix that walked every device would take longer than the transfer it plans.
It is therefore only as accurate as the last reconciliation; `device/sync-enrolment`
is what repairs it.

`distribute` takes an optional `sourceDeviceId`, which makes one request cover
the whole "pull these people off the door terminal and put them on the other
three" errand: anything with no stored template is captured from that terminal
first, then the whole selection is pushed onto every target.

Three properties matter more than the endpoints themselves:

- **Devices run in parallel, subjects sequentially within a device.** A session
  serialises its own commands anyway, so per-device concurrency would only queue;
  fanning out across devices is the part that actually saves time.
- **A subject a terminal already holds a face for is skipped** unless
  `skipEnrolled: false`. Re-running after fixing three failures costs three
  commands, not three hundred.
- **Nothing aborts the batch.** Every subject–device pair comes back with its own
  status (`pushed`, `skipped`, `no-template`, `device-offline`, `failed`) and, for
  failures, the device's own reason. An offline terminal is reported once for the
  device rather than as N identical failures.

`subjects × deviceIds` is capped at 500 per request; larger selections must be
split by the caller. The cap exists because the whole batch is one HTTP response
and each pair is a device round trip.

Enrolment does **not** check parental consent. The workflow that populates
`BiometricConsentRequest` is not built yet, so the check refused every student
and was removed. `TerminalFaceTemplate.consentRequestId` is still populated
whenever an approved row happens to exist, so evidence is captured once that
workflow lands; restoring the gate then means rejecting a null lookup in
`findApprovedConsent`.

### `RemoteEnroll` cannot be bound to a user — confirmed on hardware

The SDK defines `RemoteEnroll` with `<Backup>` and an optional `<FingerNo>` and
**no `UserID`**, so there is no way to tell the device which slot to enrol into.
A real terminal answers `EnrollNumberError` (confirmed Aug 2026). Even had it
succeeded, the device would have chosen its own number and desynced from
`TerminalUser`, surfacing later as `UNKNOWN` scans — the refusal is the safer
outcome. `/enroll/remote` is kept only to document this; it is not a working path.

There is no other command that starts a capture at the device: the rest
(`EnrollFaceByPhoto`, `SetUserData`, `SetFaceData`, `GetFaceData`) all require
the biometric data already in hand.

#### The device will not tell you an enrolment is underway

Two protocol facts, worth stating plainly because together they read as "nothing
is happening":

1. **`ResultCode` is about the mode, not about a face.** It comes back as soon
   as the device decides whether it can *enter* enrolment mode — `MenuProcessing`
   and `RemoteEnrollAlreadyStarted` are both "not right now". A `Success` means
   the device is waiting for a face, not that it captured one.
2. **There is no completion event.** The SDK has no "enrolment finished" frame.

So the only three signals that exist are:

| Signal | What it tells you |
|---|---|
| The `RemoteEnroll` response | whether the device entered enrolment mode at all |
| `AdminLog_v2` with an `Enroll*` action | that somebody completed an enrolment at the keypad — `GET :deviceId/device/admin-logs?category=enrollment` |
| `GetUserData` → `FaceEnrolled` | the authoritative state, on demand — `GET :deviceId/device/users/{terminalUserId}` |

`POST :deviceId/enroll/remote` therefore returns `200` with the device's own
`ResultCode`, a plain-language reading of it and the next step, rather than a
bare `409` — on this hardware the refusal *is* the answer. `POST
:deviceId/enroll/cancel` doubles as the only probe for whether the device is in
enrolment mode (`wasActive: false` ⇒ it answered `NotStartedRemoteEnroll`), at
the cost of ending that mode.

Note also that a `Success` no longer marks the subject face-enrolled in
`TerminalUser`. It previously did, which made our mirror claim a face that may
never have been captured.

So an at-the-device enrolment is a three-step dance, of which the cloud drives
two — and it is needed **once per person for the whole site**, not once per gate:

```
POST /v1/tenants/{t}/terminals/{deviceId}/users            # 1. named empty slot
                                                            # 2. enrol at the device menu
POST /v1/tenants/{t}/terminals/{deviceId}/templates/capture # 3. harvest the template
POST /v1/tenants/{t}/terminals/{other}/templates/replicate  #    then push to every other gate
```

Step 2 is the only part needing a person at the terminal, and because they are
enrolling against a record that already carries their name and number, the
mapping stays in sync. `/enroll/photo` skips step 2 entirely when a compliant
sub-32KB JPEG is available.

## Linking device faces to students

Three routes exist. They differ in who chooses the slot number, which is the
only thing that decides whether the mapping stays honest.

| Route | Needs | Who picks the number | Good for |
|---|---|---|---|
| `POST enroll/photo` | a sub-32KB JPEG that the device accepts | we do | subjects with a usable photo on file |
| `POST users` → enrol at the menu → `POST templates/capture` | somebody to key in the number at the device | we do | the default from the Face Enrollment screen: it shows the reserved number, and the operator keys that one in |
| enrol at the menu → `POST users/{slot}/claim` | somebody who can recognise the face afterwards | the device does | bulk intake — the default |

The third is the practical one, and it is why `GetUserPhoto` matters. Enrolment
happens at the terminal, under whatever lighting is really there, with the live
face and no photograph needed in advance. The firmware picks its own number and
announces it only through `AdminLog_v2`. The cloud then catches up:

```
GET  /v1/tenants/{t}/terminals/{deviceId}/device/unclaimed          # what turned up
GET  /v1/tenants/{t}/terminals/{deviceId}/device/users/{slot}/photo # who is it?
POST /v1/tenants/{t}/terminals/{deviceId}/users/{slot}/claim        # bind it
     { "subjectType": "STUDENT", "subjectId": "...", "renameOnDevice": true,
       "captureTemplate": true }
```

`device/unclaimed` returns each unbound slot with the name typed at the keypad,
whether the device considers a face enrolled, and when the enrolment happened
according to the admin log — ordered by that time, so an intake session comes
back in the order people queued. `GetUserPhoto` returns the enrolment JPEG,
which is what makes the slot identifiable to someone who knows the students; it
is **not** `GetFaceData`, which returns the opaque matching template a human
cannot read.

Claiming checks the hardware rather than trusting the request. The slot must
actually exist on the device — claiming an empty number would manufacture a
mapping that silently swallows whoever is given that number next. `faceEnrolled`
is copied from the device's own answer instead of being assumed. The slot must
be unclaimed, and the subject must not already hold a different slot here, since
two numbers for one person split their scans across both identities depending on
which face the device matches.

`renameOnDevice` pushes our canonical name over whatever was typed at the
keypad, so the terminal stays readable to whoever is standing at it;
`captureTemplate` harvests the template in the same call so it can be replicated
to the other gates. Both are best-effort — the mapping is committed either way,
and failures come back in `warnings`.

`DELETE users/{slot}/claim` is the undo for a slot bound to the wrong student.
Unlike `DELETE users/{subjectType}/{subjectId}`, it does not touch the terminal:
the face stays where it is and the slot returns to the unclaimed queue.

### Knowing that an at-the-device enrolment happened

Reserving a slot with `POST users` and then enrolling the face at the terminal
splits the work across two systems, and the device does not report the half it
owns. There is no "enrolment finished" frame addressed to us, and no command to
ask "has anything changed since?". Left alone, the operator sees a student
listed as *Awaiting face* indefinitely — including students who have been
walking through the gate for a week.

Three signals close it, in order of how quickly they arrive:

1. **`AdminLog_v2`.** Seconds after the person lifts their face from the
   terminal. An `Enroll*` action against a slot we map flips `faceEnrolled`
   immediately. This is the good case, and it needs nothing from anybody — but
   it only fires if the terminal was connected at that moment, and only if this
   firmware's action string is one the classifier recognises as an enrolment.
   Admin logs are push-only and cannot be re-read, so a disconnection loses it
   permanently.
2. **The first successful scan.** A terminal that matched a face against a slot
   has proved a face is in that slot, whatever our record says. `resolveSubject`
   flips the flag on the way past. This one cannot be missed — it arrives on the
   same frame as the evidence — but it costs the person one walk through the
   gate. Only `GRANTED` counts: a refusal is as likely to mean the slot is empty
   as to mean the wrong person stood in front of it.
3. **`POST device/sync-enrolment`.** The explicit repair, and the only one that
   works retroactively. It walks the user list and takes the device's own
   `FaceEnrolled` flag as the truth for every mapped slot, in both directions:

   ```
   POST /v1/tenants/{t}/terminals/{deviceId}/device/sync-enrolment
   ```

   The reverse direction matters as much as the forward one. A face deleted at
   the keypad leaves us showing a student as enrolled at a gate that will not
   recognise them, which is the same error pointing the other way and harder to
   notice.

   Mapped slots the device does not have *at all* are reported in
   `missingOnDevice` and never changed. Absent is not the same as
   present-with-no-face: a walk cut short by a dropped connection looks
   identical, and guessing would silently disable a student. The response also
   carries `unmapped` — slots the hardware holds that nothing is bound to, whose
   scans record as `UNKNOWN`.

   It costs one full user-list walk and blocks other commands on that terminal
   while it runs, which is why it is a button (*Check the device*) rather than a
   timer.

Both automatic paths are best-effort by design: they log and move on rather than
fail. The audit row for an admin log and the attendance record for a scan are
the parts that cannot be recovered; a missed flag is repaired by the next scan
or by a sync.

### What claiming does not do

It does not retro-attribute past scans. Anything that slot recorded before the
claim is already stored as `subjectType: UNKNOWN`, and fixing those is not
currently possible: `AuthEvent` stores the resolved subject but not the terminal
slot number, so there is nothing to join on. Recovering them would mean either
adding the slot to `AuthEvent` (a migration against a partitioned table) or
walking the device's glog to map `LogID` → `UserID` and matching on `frameKey`.
Neither is built. **Claim before the students start using the gate**, or accept
a gap.

## Operator UI

Two screens, split by what the operator is trying to achieve:

- **Face Enrollment** (`/enrollment`) — getting a person onto the gates. One row
  per student, showing how many terminals hold their face, so "enrolled" can
  never mean "enrolled somewhere that does not open this door". Enrolling at the
  terminal is the primary route: the page reserves a numbered slot and shows the
  number large, because the whole point of reserving is that somebody has to key
  it in at the device. *Check the device* then confirms the face landed, and one
  button copies it to the remaining gates. Photo enrolment is the secondary
  route, kept for when nobody can get to a terminal; the page shrinks the JPEG to
  fit the 32KB the device accepts rather than asking the operator to re-save it.

  *Face held on the terminals* pulls the enrolment photo off the hardware, so a
  warden can see who is actually in a student's slot rather than trusting the
  name on the row. It asks the gates in turn — the one the template came from
  first — because only the terminal somebody enrolled at keeps a picture.
- **Biometric Terminals** (`/terminals`) — the devices themselves. Registering a
  terminal, the *Waiting to be linked* queue where a face enrolled at the keypad
  gets bound to a student, *Check the device* to reconcile our enrolment flags
  against the hardware's, and the log held on the device. Each queue entry shows
  the enrolment photo on demand, so the binding is made by looking at the person
  rather than trusting a keypad label. Unlinking is separate from deleting: it
  returns the slot to the queue and leaves the face on the device.

  *Copy faces between terminals* is the fleet tool: pick people, pick gates, and
  it plans the transfer server-side. Each terminal card also carries its own
  count of faces the rest of the fleet has and it does not.

The hardware-verification bench that used to live at `/terminals/hardware` has
been removed from the UI. The endpoints it drove are still mounted and still
documented below — they are reachable through Swagger when a device misbehaves —
but they are not part of any daily workflow and the screen was being read as one.

## Reading what the device actually holds

Four read-only endpoints, all of which ask the hardware or the trail rather than
our mirror of it — which is the point, because the mirror is what drifts.

```
GET /v1/tenants/{t}/terminals/{deviceId}/device/status              # firmware, counts, our cursor
GET /v1/tenants/{t}/terminals/{deviceId}/device/logs                # attendance, from the device
GET /v1/tenants/{t}/terminals/{deviceId}/device/users               # every slot, diffed against ours
GET /v1/tenants/{t}/terminals/{deviceId}/device/users/{slot}        # one slot, as the device holds it
GET /v1/tenants/{t}/terminals/{deviceId}/device/users/{slot}/photo  # the enrolment JPEG
GET /v1/tenants/{t}/terminals/{deviceId}/device/unclaimed           # slots not bound to anyone
GET /v1/tenants/{t}/terminals/{deviceId}/device/admin-logs          # AdminLog_v2 history
```

### `AdminLog_v2` — administration history

Menu entries, keypad enrolments and deletions, setting and clock changes, with
slot numbers resolved to subjects and each entry classified
(`enrollment` / `deletion` / `configuration` / `session` / `other`). Filter with
`?category=enrollment` after asking someone to enrol at the terminal — that is
the completion signal the SDK does not otherwise provide.

**These cannot be re-pulled.** The SDK has `GetFirstGlog`/`GetNextGlog` for
attendance and **no equivalent for administration**, so an admin log we fail to
persist is gone for good. That asymmetry is why `AdminLog_v2` is acknowledged
only after the audit row commits, and why this endpoint reads the audit trail
rather than the device. Compare `occurredAt` (device clock) against `receivedAt`
(when we committed it): a wide gap means the terminal was buffering.

The vendor's action enum is fingerprint-era — `EnrollUserFP`, `DeleteFP`, and
no face variant at all — so classification matches the verb rather than the
exact literal. An M50 spelling its face enrolment `EnrollUserFace`, or reusing a
neighbouring name, still files as an enrolment instead of vanishing into
"other".

### `device/users` — reconciliation

Walks the terminal's whole user list and diffs it against `TerminalUser`:

- `summary.unmappedOnDevice` — the hardware recognises them, we cannot name
  them. These produce `UNKNOWN` scans and are the numbers most at risk of being
  written over.
- `summary.missingOnDevice` — we believe in them, the hardware does not. Those
  subjects cannot pass this gate.
- `summary.nameMismatch` — both sides hold the slot under different names. The
  signature of an enrolment landing on an existing user.
- `summary.faceDrift` — the two disagree about whether a face is enrolled.

It blocks enrolment on that terminal while it runs, because device commands are
serialised one at a time per connection.

## Operational notes

- **Idempotency.** `frameKey` is derived as `m50/{serial}/{logId}.jpg` from the
  device's monotonic `LogID`, which is what makes replays safe — the live stream
  and a backfill can deliver the same record without double-counting.
- **Acks.** A `TimeLog` is acknowledged only once its job is durably queued. On
  failure we reply `Fail`, leaving the record on the device for backfill.
- **Clocks.** The protocol stamps a trailing `Z` it does not honour; timestamps
  are interpreted in the site's timezone (override with `M50_CLOCK_TZ`).
  `KeepAlive` replies carry `ServerTime` so the device can correct drift.
- **Single instance.** A terminal's socket is pinned to the replica it dialled
  and `TerminalSessionRegistry` is in-process, so commands must originate on the
  owning instance. Running multiple replicas needs routing that raw sockets,
  unlike the Socket.IO Redis adapter, do not provide.
- **Not yet wired.** `<LogImage>` frames are not uploaded; `frameKey` currently
  names an object that does not exist.
