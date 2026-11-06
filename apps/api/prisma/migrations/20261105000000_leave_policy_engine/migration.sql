-- Additive only: every new column is nullable or has a default, so existing rows keep their meaning.

-- AlterTable
ALTER TABLE "sites" ADD COLUMN "lat" DOUBLE PRECISION,
ADD COLUMN "lng" DOUBLE PRECISION,
ADD COLUMN "geofence_radius_m" INTEGER,
ADD COLUMN "geofence_strict" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "attendance_policies" ADD COLUMN "early_exit_counts_as_late" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "absence_deduction" DOUBLE PRECISION NOT NULL DEFAULT 1,
ADD COLUMN "pairing" TEXT NOT NULL DEFAULT 'FIRST_LAST';

-- AlterTable
ALTER TABLE "employees" ADD COLUMN "leave_entitlements" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "attendance_days" ADD COLUMN "permission_minutes" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "leave_types" ADD COLUMN "unit" TEXT NOT NULL DEFAULT 'DAYS',
ADD COLUMN "entitlements" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "min_service_days" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "max_per_month" DECIMAL(5,1),
ADD COLUMN "max_requests_per_month" INTEGER;

-- AlterTable
ALTER TABLE "leave_requests" ADD COLUMN "start_time" TEXT,
ADD COLUMN "end_time" TEXT,
ADD COLUMN "minutes" INTEGER;

-- AlterTable
ALTER TABLE "remote_work_requests" ADD COLUMN "manager_approver_id" TEXT,
ADD COLUMN "manager_decided_at" TIMESTAMP(3);
