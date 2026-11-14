-- CreateTable
CREATE TABLE "translation_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "translationKey" TEXT NOT NULL,
    "activeKey" TEXT,
    "state" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "mediaTitle" TEXT NOT NULL,
    "mediaType" TEXT,
    "imdbId" TEXT,
    "season" INTEGER,
    "episode" INTEGER,
    "sourceName" TEXT,
    "sourceLanguage" TEXT,
    "targetLanguage" TEXT NOT NULL,
    "targetScript" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "customInstructions" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "usedModels" TEXT,
    "sourceFile" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "outputFile" TEXT,
    "percentage" REAL NOT NULL DEFAULT 0,
    "totalEntries" INTEGER NOT NULL DEFAULT 0,
    "completedEntries" INTEGER NOT NULL DEFAULT 0,
    "totalSegments" INTEGER NOT NULL DEFAULT 0,
    "completedSegments" INTEGER NOT NULL DEFAULT 0,
    "currentSegment" INTEGER,
    "etaSeconds" INTEGER,
    "statusDetail" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "costKnown" BOOLEAN NOT NULL DEFAULT true,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "errorStage" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "lockedBy" TEXT,
    "leaseExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "job_segments" (
    "jobId" TEXT NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "entries" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "result" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,

    PRIMARY KEY ("jobId", "segmentIndex"),
    CONSTRAINT "job_segments_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "translation_jobs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "job_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "jobId" TEXT,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "readAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "translation_jobs_activeKey_key" ON "translation_jobs"("activeKey");

-- CreateIndex
CREATE INDEX "translation_jobs_state_createdAt_idx" ON "translation_jobs"("state", "createdAt");

-- CreateIndex
CREATE INDEX "translation_jobs_translationKey_idx" ON "translation_jobs"("translationKey");

-- CreateIndex
CREATE INDEX "job_events_createdAt_idx" ON "job_events"("createdAt");

-- CreateIndex
CREATE INDEX "notifications_readAt_createdAt_idx" ON "notifications"("readAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_jobId_kind_attempt_key" ON "notifications"("jobId", "kind", "attempt");
