-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROVISIONING',
    "suspended_at" TIMESTAMP(3),
    "suspended_reason" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "holiday_calendar_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "head_employee_id" TEXT,
    "policy_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_projects" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "from" DATE NOT NULL,
    "to" DATE,

    CONSTRAINT "employee_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holiday_calendars" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holiday_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "calendar_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_policies" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "grace_in_minutes" INTEGER NOT NULL DEFAULT 10,
    "grace_out_minutes" INTEGER NOT NULL DEFAULT 10,
    "half_day_min_percent" INTEGER NOT NULL DEFAULT 50,
    "full_day_min_percent" INTEGER NOT NULL DEFAULT 90,
    "early_window_minutes" INTEGER NOT NULL DEFAULT 180,
    "late_window_minutes" INTEGER NOT NULL DEFAULT 360,
    "duplicate_punch_seconds" INTEGER NOT NULL DEFAULT 60,
    "min_session_minutes" INTEGER NOT NULL DEFAULT 5,
    "absent_after_minutes" INTEGER NOT NULL DEFAULT 120,
    "missed_out_credit" TEXT NOT NULL DEFAULT 'NONE',
    "overtime_enabled" BOOLEAN NOT NULL DEFAULT false,
    "overtime_min_minutes" INTEGER NOT NULL DEFAULT 30,
    "break_deduction" TEXT NOT NULL DEFAULT 'SHIFT_BREAK',
    "rounding_minutes" INTEGER NOT NULL DEFAULT 0,
    "min_rest_hours" INTEGER NOT NULL DEFAULT 8,
    "max_weekly_hours" INTEGER NOT NULL DEFAULT 60,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "employee_id" TEXT,
    "role" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "site_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "department_id" TEXT,
    "manager_id" TEXT,
    "employee_code" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "designation" TEXT,
    "employment_type" TEXT NOT NULL DEFAULT 'FULL_TIME',
    "joined_on" DATE NOT NULL,
    "exit_on" DATE,
    "mobile_punch" TEXT NOT NULL DEFAULT 'NEVER',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "user_id" TEXT,
    "biometric_consent_at" TIMESTAMP(3),
    "biometric_consent_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "serial_no" TEXT NOT NULL,
    "name" TEXT,
    "gate_name" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "clock_timezone" TEXT,
    "terminal_token" TEXT,
    "terminal_type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'provisioned',
    "last_seen_at" TIMESTAMP(3),
    "last_log_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terminal_users" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "terminal_user_id" INTEGER NOT NULL,
    "subject_type" TEXT NOT NULL DEFAULT 'EMPLOYEE',
    "subject_id" TEXT NOT NULL,
    "face_enrolled" BOOLEAN NOT NULL DEFAULT false,
    "enrolled_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "terminal_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terminal_face_templates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL DEFAULT 'EMPLOYEE',
    "subject_id" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "terminal_type" TEXT,
    "template" TEXT NOT NULL,
    "template_sha256" TEXT NOT NULL,
    "source_device_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "terminal_face_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "punches" (
    "id" TEXT NOT NULL,
    "punched_at" TIMESTAMPTZ(3) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "employee_id" TEXT,
    "device_id" TEXT,
    "terminal_user_id" INTEGER,
    "device_log_id" INTEGER,
    "source" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'GRANTED',
    "work_date" DATE,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "accuracy" DOUBLE PRECISION,
    "is_mock_location" BOOLEAN,
    "correction_id" TEXT,
    "reason" TEXT,
    "created_by" TEXT,
    "photo_key" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "punches_pkey" PRIMARY KEY ("id","punched_at")
);

-- CreateTable
CREATE TABLE "attendance_days" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "work_date" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "day_type" TEXT NOT NULL,
    "holiday_name" TEXT,
    "shift_id" TEXT,
    "shift_kind" TEXT,
    "shift_break_minutes" INTEGER NOT NULL DEFAULT 0,
    "sched_start" TIMESTAMPTZ(3),
    "sched_end" TIMESTAMPTZ(3),
    "core_start" TIMESTAMPTZ(3),
    "core_end" TIMESTAMPTZ(3),
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "window_end" TIMESTAMPTZ(3) NOT NULL,
    "required_minutes" INTEGER NOT NULL DEFAULT 0,
    "policy_id" TEXT,
    "policy" JSONB NOT NULL DEFAULT '{}',
    "first_in" TIMESTAMPTZ(3),
    "last_out" TIMESTAMPTZ(3),
    "segments" JSONB NOT NULL DEFAULT '[]',
    "worked_minutes" INTEGER NOT NULL DEFAULT 0,
    "break_minutes" INTEGER NOT NULL DEFAULT 0,
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "early_exit_minutes" INTEGER NOT NULL DEFAULT 0,
    "overtime_minutes" INTEGER NOT NULL DEFAULT 0,
    "punch_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "live_state" TEXT NOT NULL DEFAULT 'NOT_YET_IN',
    "is_late" BOOLEAN NOT NULL DEFAULT false,
    "is_early_exit" BOOLEAN NOT NULL DEFAULT false,
    "missed_punch" BOOLEAN NOT NULL DEFAULT false,
    "worked_on_off_day" BOOLEAN NOT NULL DEFAULT false,
    "has_leave_conflict" BOOLEAN NOT NULL DEFAULT false,
    "leave_portion" DECIMAL(2,1) NOT NULL DEFAULT 0,
    "leave_half" TEXT,
    "leave_type_id" TEXT,
    "remote" BOOLEAN NOT NULL DEFAULT false,
    "corrected" BOOLEAN NOT NULL DEFAULT false,
    "finalized_at" TIMESTAMP(3),
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_corrections" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "work_date" DATE NOT NULL,
    "in_at" TIMESTAMPTZ(3),
    "out_at" TIMESTAMPTZ(3),
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requested_by" TEXT NOT NULL,
    "approver_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#cd0447',
    "kind" TEXT NOT NULL DEFAULT 'FIXED',
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "break_minutes" INTEGER NOT NULL DEFAULT 0,
    "required_minutes" INTEGER NOT NULL,
    "core_start" TEXT,
    "core_end" TEXT,
    "works_holidays" BOOLEAN NOT NULL DEFAULT false,
    "policy_id" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_patterns" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cycle_days" INTEGER NOT NULL,
    "days" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_schedules" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "shift_id" TEXT,
    "weekly_offs" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "pattern_id" TEXT,
    "anchor_date" DATE,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_overrides" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "shift_id" TEXT,
    "reason" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roster_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_types" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#2563eb',
    "paid" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "allow_half_day" BOOLEAN NOT NULL DEFAULT true,
    "accrual_kind" TEXT NOT NULL DEFAULT 'NONE',
    "accrual_amount" DECIMAL(5,1) NOT NULL DEFAULT 0,
    "max_balance" DECIMAL(5,1),
    "carry_forward_max" DECIMAL(5,1),
    "allow_negative" BOOLEAN NOT NULL DEFAULT false,
    "requires_attachment" BOOLEAN NOT NULL DEFAULT false,
    "min_notice_days" INTEGER NOT NULL DEFAULT 0,
    "counts_off_days" BOOLEAN NOT NULL DEFAULT false,
    "requires_hr_approval" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_ledger" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "leave_type_id" TEXT NOT NULL,
    "leave_year" INTEGER NOT NULL,
    "delta" DECIMAL(5,1) NOT NULL,
    "kind" TEXT NOT NULL,
    "request_id" TEXT,
    "period_key" TEXT,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "leave_type_id" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "start_half" TEXT,
    "end_half" TEXT,
    "days" DECIMAL(5,1) NOT NULL,
    "reason" TEXT,
    "attachment_key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "manager_approver_id" TEXT,
    "manager_decided_at" TIMESTAMP(3),
    "approver_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remote_work_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approver_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "remote_work_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_jobs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "requested_by" TEXT,
    "schedule_id" TEXT,
    "type" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "scope" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "storage_key" TEXT,
    "sha256" TEXT,
    "row_count" INTEGER,
    "error" TEXT,
    "generated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_schedules" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "recipient_user_ids" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_devices" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_notifications" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "site_id" TEXT,
    "actor_user_id" TEXT,
    "actor_type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "sites_tenant_id_idx" ON "sites"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_tenant_id_name_key" ON "departments"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "projects_tenant_id_name_key" ON "projects"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "employee_projects_project_id_idx" ON "employee_projects"("project_id");

-- CreateIndex
CREATE INDEX "employee_projects_employee_id_idx" ON "employee_projects"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_calendar_id_date_key" ON "holidays"("calendar_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_employee_id_key" ON "user_profiles"("employee_id");

-- CreateIndex
CREATE INDEX "user_profiles_tenant_id_idx" ON "user_profiles"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_user_id_key" ON "employees"("user_id");

-- CreateIndex
CREATE INDEX "employees_tenant_id_status_idx" ON "employees"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "employees_manager_id_idx" ON "employees"("manager_id");

-- CreateIndex
CREATE INDEX "employees_department_id_idx" ON "employees"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_tenant_id_employee_code_key" ON "employees"("tenant_id", "employee_code");

-- CreateIndex
CREATE UNIQUE INDEX "devices_serial_no_key" ON "devices"("serial_no");

-- CreateIndex
CREATE INDEX "devices_tenant_id_idx" ON "devices"("tenant_id");

-- CreateIndex
CREATE INDEX "terminal_users_subject_id_idx" ON "terminal_users"("subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "terminal_users_device_id_terminal_user_id_key" ON "terminal_users"("device_id", "terminal_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "terminal_users_device_id_subject_type_subject_id_key" ON "terminal_users"("device_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "terminal_face_templates_tenant_id_idx" ON "terminal_face_templates"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "terminal_face_templates_subject_type_subject_id_vendor_key" ON "terminal_face_templates"("subject_type", "subject_id", "vendor");

-- CreateIndex
CREATE INDEX "punches_employee_id_punched_at_idx" ON "punches"("employee_id", "punched_at");

-- CreateIndex
CREATE INDEX "punches_site_id_punched_at_idx" ON "punches"("site_id", "punched_at");

-- CreateIndex
CREATE INDEX "punches_tenant_id_punched_at_idx" ON "punches"("tenant_id", "punched_at");

-- CreateIndex
CREATE UNIQUE INDEX "punches_device_id_device_log_id_punched_at_key" ON "punches"("device_id", "device_log_id", "punched_at");

-- CreateIndex
CREATE INDEX "attendance_days_tenant_id_work_date_status_idx" ON "attendance_days"("tenant_id", "work_date", "status");

-- CreateIndex
CREATE INDEX "attendance_days_site_id_work_date_idx" ON "attendance_days"("site_id", "work_date");

-- CreateIndex
CREATE INDEX "attendance_days_window_end_finalized_at_idx" ON "attendance_days"("window_end", "finalized_at");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_days_employee_id_work_date_key" ON "attendance_days"("employee_id", "work_date");

-- CreateIndex
CREATE INDEX "attendance_corrections_tenant_id_status_idx" ON "attendance_corrections"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "attendance_corrections_employee_id_work_date_idx" ON "attendance_corrections"("employee_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_tenant_id_code_key" ON "shifts"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "employee_schedules_employee_id_effective_from_idx" ON "employee_schedules"("employee_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "roster_overrides_employee_id_date_key" ON "roster_overrides"("employee_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "leave_types_tenant_id_code_key" ON "leave_types"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "leave_ledger_employee_id_leave_year_idx" ON "leave_ledger"("employee_id", "leave_year");

-- CreateIndex
CREATE UNIQUE INDEX "leave_ledger_employee_id_leave_type_id_period_key_key" ON "leave_ledger"("employee_id", "leave_type_id", "period_key");

-- CreateIndex
CREATE INDEX "leave_requests_tenant_id_status_idx" ON "leave_requests"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "leave_requests_employee_id_start_date_idx" ON "leave_requests"("employee_id", "start_date");

-- CreateIndex
CREATE INDEX "remote_work_requests_tenant_id_status_idx" ON "remote_work_requests"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "remote_work_requests_employee_id_start_date_idx" ON "remote_work_requests"("employee_id", "start_date");

-- CreateIndex
CREATE INDEX "report_jobs_tenant_id_created_at_idx" ON "report_jobs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "push_devices_token_key" ON "push_devices"("token");

-- CreateIndex
CREATE INDEX "push_devices_user_id_idx" ON "push_devices"("user_id");

-- CreateIndex
CREATE INDEX "app_notifications_user_id_created_at_idx" ON "app_notifications"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_idx" ON "audit_logs"("target_type", "target_id");

-- AddForeignKey
ALTER TABLE "employee_projects" ADD CONSTRAINT "employee_projects_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_projects" ADD CONSTRAINT "employee_projects_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_calendar_id_fkey" FOREIGN KEY ("calendar_id") REFERENCES "holiday_calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terminal_users" ADD CONSTRAINT "terminal_users_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "punches" ADD CONSTRAINT "punches_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "punches" ADD CONSTRAINT "punches_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leave_type_id_fkey" FOREIGN KEY ("leave_type_id") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_work_requests" ADD CONSTRAINT "remote_work_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
