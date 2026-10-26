-- AlterTable
ALTER TABLE "punches" ADD COLUMN     "review_status" TEXT,
ADD COLUMN     "reviewed_by" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMP(3),
ADD COLUMN     "review_note" TEXT;

-- CreateIndex
CREATE INDEX "punches_tenant_id_review_status_punched_at_idx" ON "punches"("tenant_id", "review_status", "punched_at");
