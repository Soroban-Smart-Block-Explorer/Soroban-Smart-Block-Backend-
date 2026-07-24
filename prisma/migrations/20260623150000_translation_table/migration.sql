-- CreateTable
CREATE TABLE "TranslationKey" (
    "id"          TEXT NOT NULL,
    "key"         TEXT NOT NULL,
    "defaultText" TEXT NOT NULL,
    "context"     TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranslationKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TranslationKey_key_key" ON "TranslationKey"("key");

-- CreateIndex
CREATE INDEX "TranslationKey_key_idx" ON "TranslationKey"("key");

-- CreateTable
CREATE TABLE "Translation" (
    "id"             TEXT NOT NULL,
    "keyId"          TEXT NOT NULL,
    "language"       TEXT NOT NULL,
    "translatedText" TEXT NOT NULL,
    "approvedBy"     TEXT,
    "approvedAt"     TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Translation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Translation_keyId_language_key" ON "Translation"("keyId", "language");

-- CreateIndex
CREATE INDEX "Translation_keyId_idx" ON "Translation"("keyId");

-- CreateIndex
CREATE INDEX "Translation_language_idx" ON "Translation"("language");

-- AddForeignKey
ALTER TABLE "Translation" ADD CONSTRAINT "Translation_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "TranslationKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
