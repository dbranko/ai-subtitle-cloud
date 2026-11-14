-- CreateTable
CREATE TABLE "source_subtitles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hash" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT,
    "language" TEXT,
    "fileName" TEXT,
    "release" TEXT,
    "mediaType" TEXT,
    "imdbId" TEXT,
    "season" INTEGER,
    "episode" INTEGER,
    "videoHash" TEXT,
    "entries" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "file" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "lastUsedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "translations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "translationKey" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetLanguage" TEXT NOT NULL,
    "targetScript" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "customInstructions" TEXT,
    "promptVersion" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "models" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "entries" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "validation" TEXT NOT NULL,
    "stats" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "lastUsedAt" DATETIME NOT NULL,
    CONSTRAINT "translations_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "source_subtitles" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "media_links" (
    "mediaKey" TEXT NOT NULL PRIMARY KEY,
    "translationKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_translation_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "translationKey" TEXT NOT NULL,
    "activeKey" TEXT,
    "mediaKey" TEXT,
    "mediaQuery" TEXT,
    "force" BOOLEAN NOT NULL DEFAULT false,
    "cacheHit" BOOLEAN NOT NULL DEFAULT false,
    "runAfter" DATETIME,
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
    "sourceId" TEXT,
    "sourceFile" TEXT,
    "sourceHash" TEXT,
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
INSERT INTO "new_translation_jobs" ("activeKey", "attempt", "cancelRequested", "completedAt", "completedEntries", "completedSegments", "costKnown", "costUsd", "createdAt", "currentSegment", "customInstructions", "episode", "errorCode", "errorMessage", "errorStage", "etaSeconds", "id", "imdbId", "inputTokens", "leaseExpiresAt", "lockedBy", "mediaTitle", "mediaType", "model", "origin", "outputFile", "outputTokens", "percentage", "profile", "provider", "retryCount", "season", "sourceFile", "sourceHash", "sourceLanguage", "sourceName", "startedAt", "state", "statusDetail", "targetLanguage", "targetScript", "totalEntries", "totalSegments", "translationKey", "updatedAt", "usedModels") SELECT "activeKey", "attempt", "cancelRequested", "completedAt", "completedEntries", "completedSegments", "costKnown", "costUsd", "createdAt", "currentSegment", "customInstructions", "episode", "errorCode", "errorMessage", "errorStage", "etaSeconds", "id", "imdbId", "inputTokens", "leaseExpiresAt", "lockedBy", "mediaTitle", "mediaType", "model", "origin", "outputFile", "outputTokens", "percentage", "profile", "provider", "retryCount", "season", "sourceFile", "sourceHash", "sourceLanguage", "sourceName", "startedAt", "state", "statusDetail", "targetLanguage", "targetScript", "totalEntries", "totalSegments", "translationKey", "updatedAt", "usedModels" FROM "translation_jobs";
DROP TABLE "translation_jobs";
ALTER TABLE "new_translation_jobs" RENAME TO "translation_jobs";
CREATE UNIQUE INDEX "translation_jobs_activeKey_key" ON "translation_jobs"("activeKey");
CREATE INDEX "translation_jobs_state_createdAt_idx" ON "translation_jobs"("state", "createdAt");
CREATE INDEX "translation_jobs_translationKey_idx" ON "translation_jobs"("translationKey");
CREATE INDEX "translation_jobs_mediaKey_idx" ON "translation_jobs"("mediaKey");
CREATE INDEX "translation_jobs_sourceId_idx" ON "translation_jobs"("sourceId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "source_subtitles_hash_key" ON "source_subtitles"("hash");

-- CreateIndex
CREATE INDEX "source_subtitles_imdbId_season_episode_idx" ON "source_subtitles"("imdbId", "season", "episode");

-- CreateIndex
CREATE UNIQUE INDEX "translations_translationKey_key" ON "translations"("translationKey");

-- CreateIndex
CREATE INDEX "translations_lastUsedAt_idx" ON "translations"("lastUsedAt");

-- CreateIndex
CREATE INDEX "translations_sourceId_idx" ON "translations"("sourceId");

-- CreateIndex
CREATE INDEX "media_links_translationKey_idx" ON "media_links"("translationKey");
