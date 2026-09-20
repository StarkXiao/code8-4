-- CreateTable
CREATE TABLE "AudioTimeline" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'building',
    "title" TEXT,
    "mergedTranscript" TEXT,
    "totalDurationMs" INTEGER,
    "createdBy" TEXT NOT NULL,
    "mergedBy" TEXT,
    "mergedAt" DATETIME,
    "changeNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AudioTimeline_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AudioTimeline_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AudioTimeline_mergedBy_fkey" FOREIGN KEY ("mergedBy") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TimelineTrack" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timelineId" TEXT NOT NULL,
    "audioId" TEXT NOT NULL,
    "offsetMs" INTEGER NOT NULL DEFAULT 0,
    "orderIndex" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TimelineTrack_timelineId_fkey" FOREIGN KEY ("timelineId") REFERENCES "AudioTimeline" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TimelineTrack_audioId_fkey" FOREIGN KEY ("audioId") REFERENCES "AudioAttachment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TimelineDuplicateGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timelineId" TEXT NOT NULL,
    "members" TEXT NOT NULL,
    "score" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "keepAudioId" TEXT,
    "reviewNote" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TimelineDuplicateGroup_timelineId_fkey" FOREIGN KEY ("timelineId") REFERENCES "AudioTimeline" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AudioTimeline_recipeId_status_idx" ON "AudioTimeline"("recipeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TimelineTrack_timelineId_audioId_key" ON "TimelineTrack"("timelineId", "audioId");

-- CreateIndex
CREATE INDEX "TimelineTrack_timelineId_orderIndex_idx" ON "TimelineTrack"("timelineId", "orderIndex");

-- CreateIndex
CREATE INDEX "TimelineDuplicateGroup_timelineId_status_idx" ON "TimelineDuplicateGroup"("timelineId", "status");
