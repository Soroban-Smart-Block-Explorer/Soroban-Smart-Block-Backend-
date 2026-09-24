-- CreateTable
CREATE TABLE "_saved_searches" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "criteria" JSONB NOT NULL,
    "notify" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "last_matched_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_saved_searches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "_saved_searches_user_id_is_active_idx" ON "_saved_searches"("user_id", "is_active");

-- CreateIndex
CREATE INDEX "_saved_searches_target_type_is_active_idx" ON "_saved_searches"("target_type", "is_active");
