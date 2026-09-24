-- AlterTable: challenge/response verification state for webhook subscriptions.
-- `verification_token` stores the SHA-256 digest of the in-flight challenge,
-- not the plaintext challenge, so a database leak cannot be replayed.
ALTER TABLE "_webhook_subscriptions"
    ADD COLUMN "verified" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "verified_at" TIMESTAMP(3),
    ADD COLUMN "verification_token" TEXT,
    ADD COLUMN "verification_expires_at" TIMESTAMP(3);

-- Grandfather existing subscriptions: they predate the verification handshake
-- and are already delivering successfully, so marking them unverified would
-- misrepresent their status. Only subscriptions created from now on must
-- complete the challenge/response handshake.
UPDATE "_webhook_subscriptions"
SET "verified" = true,
    "verified_at" = "created_at"
WHERE "verified" = false;
