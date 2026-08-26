-- Feature flag system: registry + per-environment/per-developer overrides.
-- Hand-authored (matches the schema in prisma/schema.prisma). The default
-- values for default_enabled / rollout_percent mirror the built-in registry
-- defaults in src/feature-flags/registry.ts.

CREATE TABLE "_feature_flags" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "default_enabled" BOOLEAN NOT NULL DEFAULT false,
    "rollout_percent" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "_feature_flags_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "_feature_flags_key_key" ON "_feature_flags"("key");

CREATE TABLE "_feature_flag_overrides" (
    "id" TEXT NOT NULL,
    "flag_key" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_value" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "_feature_flag_overrides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "_feature_flag_overrides_flag_key_scope_type_scope_value_key"
    ON "_feature_flag_overrides"("flag_key", "scope_type", "scope_value");

CREATE INDEX "_feature_flag_overrides_flag_key_scope_type_idx"
    ON "_feature_flag_overrides"("flag_key", "scope_type");

ALTER TABLE "_feature_flag_overrides"
    ADD CONSTRAINT "_feature_flag_overrides_flag_key_fkey"
    FOREIGN KEY ("flag_key") REFERENCES "_feature_flags"("key")
    ON DELETE CASCADE ON UPDATE CASCADE;
