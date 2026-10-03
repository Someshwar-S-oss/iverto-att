-- security_invoker so the views obey the caller's RLS (Postgres 15+).

CREATE OR REPLACE VIEW public.leave_balances WITH (security_invoker = true) AS
SELECT l.tenant_id,
       l.employee_id,
       l.leave_type_id,
       l.leave_year,
       SUM(l.delta)                                   AS balance,
       COALESCE(MAX(p.pending), 0)                    AS pending,
       SUM(l.delta) - COALESCE(MAX(p.pending), 0)     AS available
FROM public.leave_ledger l
LEFT JOIN (
  SELECT employee_id, leave_type_id,
         CASE WHEN EXTRACT(MONTH FROM start_date) >= 4 THEN EXTRACT(YEAR FROM start_date)
              ELSE EXTRACT(YEAR FROM start_date) - 1 END::int AS leave_year,
         SUM(days) AS pending
  FROM public.leave_requests
  WHERE status = 'PENDING'
  GROUP BY 1, 2, 3
) p ON p.employee_id = l.employee_id AND p.leave_type_id = l.leave_type_id AND p.leave_year = l.leave_year
GROUP BY l.tenant_id, l.employee_id, l.leave_type_id, l.leave_year;

CREATE OR REPLACE VIEW public.attendance_monthly_totals WITH (security_invoker = true) AS
SELECT tenant_id,
       employee_id,
       date_trunc('month', work_date)::date                     AS month,
       COUNT(*) FILTER (WHERE status = 'PRESENT')               AS present,
       COUNT(*) FILTER (WHERE status = 'ABSENT')                AS absent,
       COUNT(*) FILTER (WHERE status = 'HALF_DAY')              AS half_day,
       COUNT(*) FILTER (WHERE status IN ('ON_LEAVE','HALF_LEAVE')) AS leave,
       COUNT(*) FILTER (WHERE status = 'REMOTE')                AS remote,
       COUNT(*) FILTER (WHERE status = 'HOLIDAY')               AS holiday,
       COUNT(*) FILTER (WHERE status = 'WEEKLY_OFF')            AS weekly_off,
       COUNT(*) FILTER (WHERE is_late)                          AS late,
       SUM(worked_minutes)                                      AS worked_minutes,
       SUM(overtime_minutes)                                    AS overtime_minutes
FROM public.attendance_days
GROUP BY tenant_id, employee_id, date_trunc('month', work_date);
