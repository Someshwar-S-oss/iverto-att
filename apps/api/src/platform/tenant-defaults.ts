/**
 * What every new tenant starts with (§13.1). These are copies: editing this
 * file only affects tenants created afterwards.
 */
export const TENANT_DEFAULTS = {
  settings: {
    dayBoundary: '04:00',
    defaultWeeklyOffs: [0], // Sunday
    storePunchPhotos: false,
    punchPhotoRetentionDays: 90,
    reportRetentionDays: 90,
    branding: null as null | { logoUrl?: string; primaryColor?: string; displayName?: string },
  },
  policy: {
    name: 'Default',
    isDefault: true,
    graceInMinutes: 10,
    graceOutMinutes: 10,
    halfDayMinPercent: 50,
    fullDayMinPercent: 90,
    earlyWindowMinutes: 180,
    lateWindowMinutes: 360,
    duplicatePunchSeconds: 60,
    minSessionMinutes: 5,
    absentAfterMinutes: 120,
    missedOutCredit: 'NONE',
    overtimeEnabled: false,
    overtimeMinMinutes: 30,
    breakDeduction: 'SHIFT_BREAK',
    roundingMinutes: 0,
  },
  shift: {
    name: 'General',
    code: 'GEN',
    kind: 'FIXED',
    startTime: '09:00',
    endTime: '18:00',
    breakMinutes: 60,
    requiredMinutes: 480,
    isDefault: true,
  },
  // Inactive until the tenant admin reviews quotas.
  leaveTypes: [
    { code: 'CL', name: 'Casual Leave', color: '#2563eb', accrualKind: 'MONTHLY', accrualAmount: 1, carryForwardMax: 0, allowHalfDay: true },
    { code: 'SL', name: 'Sick Leave', color: '#059669', accrualKind: 'YEARLY_UPFRONT', accrualAmount: 12, carryForwardMax: 0, allowHalfDay: true },
    { code: 'EL', name: 'Earned Leave', color: '#d97706', accrualKind: 'MONTHLY', accrualAmount: 1.5, carryForwardMax: 30, allowHalfDay: false, minNoticeDays: 7 },
    { code: 'LOP', name: 'Loss of Pay', color: '#6b7280', accrualKind: 'NONE', accrualAmount: 0, paid: false, allowNegative: true, allowHalfDay: true },
  ],
};
