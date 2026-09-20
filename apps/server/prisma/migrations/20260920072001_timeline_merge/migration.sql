-- CreateTable
CREATE TABLE "TimelineMerge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reviewing',
    "createdBy" TEXT NOT NULL,
    "mergedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TimelineMerge_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TimelineMerge_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TimelineMergeItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mergeId" TEXT NOT NULL,
    "audioId" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "offsetMs" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TimelineMergeItem_mergeId_fkey" FOREIGN KEY ("mergeId") REFERENCES "TimelineMerge" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TimelineMergeItem_audioId_fkey" FOREIGN KEY ("audioId") REFERENCES "AudioAttachment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TimelineDuplicate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mergeId" TEXT NOT NULL,
    "normalizedText" TEXT NOT NULL,
    "displayText" TEXT NOT NULL,
    "occurrences" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolvedBy" TEXT,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TimelineDuplicate_mergeId_fkey" FOREIGN KEY ("mergeId") REFERENCES "TimelineMerge" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TimelineDuplicate_resolvedBy_fkey" FOREIGN KEY ("resolvedBy") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TimelineMerge_recipeId_status_idx" ON "TimelineMerge"("recipeId", "status");

-- CreateIndex
CREATE INDEX "TimelineMergeItem_mergeId_orderIndex_idx" ON "TimelineMergeItem"("mergeId", "orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "TimelineMergeItem_mergeId_audioId_key" ON "TimelineMergeItem"("mergeId", "audioId");

-- CreateIndex
CREATE INDEX "TimelineDuplicate_mergeId_status_idx" ON "TimelineDuplicate"("mergeId", "status");
