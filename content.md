# Iverto Attendance — Project Presentation Content

Face-recognition workforce attendance: M50 biometric terminals, a NestJS cloud API, a React web console and a mobile API for the Android app.

This file holds the full talking points. The 6-slide deck (`Iverto_Attendance.pptx`) is a condensed version of it.

---

## 1. Problem Statement

Organisations with several offices, shift workers and remote staff still track attendance with registers, card swipes or stand-alone biometric machines. This causes:

- **Proxy attendance ("buddy punching").** Cards and PINs can be shared; registers can be filled in by someone else.
- **Data stuck on devices.** Stand-alone terminals keep logs locally. HR exports them by hand, so the data is late and full of gaps.
- **Hard rules done by hand.** Night shifts that cross midnight, rotating rosters, half-day leave, holidays per location and several time zones make manual calculation slow and error-prone.
- **No live picture.** Managers can't see who is in, late or absent right now. An offline terminal quietly produces false "absent" marks.
- **Remote work can't be verified.** An employee working from a client site or home has no trustworthy way to mark attendance.
- **Weak audit trail.** Edited spreadsheets give no record of who changed what, which matters for payroll and labour compliance.

## 2. Objective

Build a multi-tenant, cloud-based attendance platform that:

1. Captures attendance **automatically and contactlessly** through face recognition on M50 terminals.
2. **Computes each employee's day correctly** from schedule, punches, leave, holidays and policy, including night shifts and multiple time zones.
3. Gives managers **real-time monitoring** of who is present, late, absent, on leave or remote.
4. Supports **leave, corrections and remote work** with approval workflows.
5. Lets remote employees **check in with a geo-tagged selfie** that a manager reviews.
6. Produces **audit-ready reports** (PDF/CSV), on demand or on a schedule.
7. Keeps every tenant's data **isolated and secure** (role-based access + database row-level security).

## 3. Proposed Solution

**Architecture: a modular monolith** (one NestJS service with clearly separated modules), chosen because terminal sockets are pinned to the process they connect to. Splitting into microservices is planned only when scale demands it.

```
M50 terminals ──WebSocket──▶ ┐
Android app  ──REST/HTTPS──▶ ├─ NestJS API (Fastify) ─┬─ PostgreSQL (Supabase, RLS)
Web console  ──REST + Socket.IO──▶ ┘                 ├─ Redis + BullMQ (jobs, recompute queue)
                                                       ├─ Supabase Storage (reports, terminal photos)
                                                       ├─ Azure Blob Storage (remote-check-in selfies)
                                                       └─ Firebase Cloud Messaging (push)
```

**Key design decisions**

| Decision | Why it matters |
|---|---|
| **Attendance is recomputed, never incremented**: `Day = f(schedule, punches, leave, holidays, policy)` | Late punches, backfill, leave approvals and corrections all become "recompute that day". Always consistent, idempotent. |
| **Raw punches are immutable**; corrections are new punches | Audit-ready by construction. |
| **Roster materialised ahead of time** | A one-minute sweeper can mark "not yet in → late → absent" without any event arriving. |
| **All times stored in UTC; work date is local; time zone lives on the site** | Multi-time-zone and night shifts without date bugs. |
| **Socket.IO for live updates** | Snapshot + deltas; on reconnect the client simply refetches. |
| **Server-side report jobs (BullMQ)** | Heavy PDF/CSV work never blocks the API; runs once across replicas. |
| **Row-level security in Postgres + app-level scoping** | Defense in depth for multi-tenant data. |

**Technology stack:** NestJS 11 + Fastify, Prisma 6, PostgreSQL (Supabase), Redis + BullMQ, Socket.IO, React 19 + Vite + TanStack Query, pdfmake, Firebase Admin, Azure Blob Storage, Jest and Vitest. Deployed on an Azure VM behind Caddy (automatic HTTPS).

## 4. Modules

| # | Module | What it does |
|---|---|---|
| 1 | **Terminal integration (M50)** | WebSocket server for face terminals: registration, face enrolment by photo, log backfill, device health watchdog. |
| 2 | **Punch pipeline** | Ingests punches from terminals, mobile, corrections and manual entry; idempotent; pushes live events. |
| 3 | **Attendance engine** | Pure function that pairs in/out punches, applies grace, late, half-day and overtime rules and produces the day's status. |
| 4 | **Shifts & roster planning** | Shifts, rotation patterns, per-employee schedules, overrides, holiday calendars per site. |
| 5 | **Leave management** | Leave types, balances via a ledger, accrual job, half-day leave, approvals. |
| 6 | **Corrections & remote work** | Missed-punch correction requests; remote-work requests; **selfie + GPS remote check-in with manager review**. |
| 7 | **Real-time monitoring** | Live board: present / late / absent / on leave / remote counts, activity feed, offline-terminal alerts. |
| 8 | **Reporting** | Report catalogue, custom report builder, branded PDF and CSV exports, scheduled reports, leaderboard ranking. |
| 9 | **Mobile API** | Endpoints for the Android app: today, monthly calendar, leave, corrections, approvals, notifications; idempotent retries. |
| 10 | **Auth, tenants & audit** | Supabase Auth (JWT/JWKS), roles (Admin, HR, Manager, Employee), platform admin for tenant provisioning, audit log for every decision. |

## 5. Results

- **Working end-to-end system** deployed on Azure at a public HTTPS endpoint; health checks report database, Redis and terminal server OK.
- **Codebase:** about 20,000 lines of TypeScript across 18 backend modules and 20+ web screens, with 30 database tables.
- **Quality:** 165 automated backend tests in 9 suites pass, covering the attendance engine (table-driven), the M50 protocol and session, backfill, leave-day calculation, CSV/PDF and custom reports; plus an end-to-end smoke test script and web unit tests.
- **Correctness by design:** recomputation handles late-arriving punches, night shifts, leave approvals and corrections consistently.
- **Real-time:** punches appear on the live board instantly; absence is detected automatically without any event arriving.
- **Remote check-in:** employees punch from the Android app with a selfie (stored in Azure Blob) plus GPS; managers review selfie, map location and time on a dedicated page and approve or reject. A rejection removes the punch from the day and notifies the employee.
- **Reporting:** branded PDF and CSV exports, scheduled automatically, with an attendance and late-arrival leaderboard.

## 6. Future Work

- **Geofencing**: auto-flag remote check-ins outside an allowed radius of the client site or home.
- **Face match on selfies**: compare the check-in selfie with the enrolled face to detect proxies automatically.
- **Liveness detection** to block photo-of-a-photo spoofing.
- **Payroll integration and export** (late-mark penalties, overtime pay).
- **Multi-level approval workflows** beyond manager + HR.
- **Email delivery** of scheduled reports and notifications.
- **Horizontal scaling**: split the terminal edge process from the API once one replica saturates; partition the punch table at large volume.
- **Analytics**: attendance trends and absence prediction.

## 7. Conclusion

Iverto Attendance replaces manual and device-bound attendance with a secure, real-time cloud platform. Contactless face recognition makes proxy attendance hard; the recompute-based engine keeps every day correct across shifts, leave and time zones; managers get a live view and audit-ready reports; and remote staff can now prove their attendance with a geo-tagged selfie. The modular design keeps the system simple to run today and leaves clear seams for scaling and for the future features above.
