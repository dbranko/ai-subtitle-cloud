-- CreateTable
CREATE TABLE "service_heartbeats" (
    "service" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "pid" INTEGER NOT NULL,
    "version" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL
);
