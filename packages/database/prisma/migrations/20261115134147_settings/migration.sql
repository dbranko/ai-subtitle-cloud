-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex (job timeline in the dashboard)
CREATE INDEX "job_events_jobId_id_idx" ON "job_events"("jobId", "id");
