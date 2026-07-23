-- CreateTable
CREATE TABLE "RateLimitOverride" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL DEFAULT '/',
    "max" INTEGER NOT NULL DEFAULT 100,
    "windowMs" INTEGER NOT NULL DEFAULT 60000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RateLimitOverride_identifier_endpoint_key" ON "RateLimitOverride"("identifier", "endpoint");
