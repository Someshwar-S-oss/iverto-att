-- AlterTable
ALTER TABLE "attendance_policies" ADD COLUMN     "late_deduction" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "late_deduction_every" INTEGER NOT NULL DEFAULT 2;
