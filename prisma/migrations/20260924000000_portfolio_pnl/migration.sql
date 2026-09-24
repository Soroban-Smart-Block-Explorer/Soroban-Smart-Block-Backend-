-- CreateTable
CREATE TABLE "_portfolio_positions" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT,
    "token" TEXT NOT NULL,
    "symbol" TEXT,
    "decimals" INTEGER NOT NULL DEFAULT 7,
    "quantity" DECIMAL(38,18) NOT NULL,
    "cost_basis_usd" DECIMAL(30,8) NOT NULL,
    "realized_pnl_usd" DECIMAL(30,8) NOT NULL DEFAULT 0,
    "acquired_at" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'manual',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_portfolio_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_portfolio_balance_snapshots" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "symbol" TEXT,
    "quantity" DECIMAL(38,18) NOT NULL,
    "price_usd" DECIMAL(30,8),
    "value_usd" DECIMAL(30,8),
    "cost_basis_usd" DECIMAL(30,8),
    "unrealized_pnl_usd" DECIMAL(30,8),
    "snapshot_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_portfolio_balance_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "_portfolio_positions_wallet_idx" ON "_portfolio_positions"("wallet");

-- CreateIndex
CREATE INDEX "_portfolio_positions_wallet_network_idx" ON "_portfolio_positions"("wallet", "network");

-- CreateIndex
CREATE UNIQUE INDEX "_portfolio_positions_wallet_network_token_key" ON "_portfolio_positions"("wallet", "network", "token");

-- CreateIndex
CREATE INDEX "_portfolio_balance_snapshots_wallet_snapshot_at_idx" ON "_portfolio_balance_snapshots"("wallet", "snapshot_at" DESC);

-- CreateIndex
CREATE INDEX "_portfolio_balance_snapshots_wallet_network_snapshot_at_idx" ON "_portfolio_balance_snapshots"("wallet", "network", "snapshot_at" DESC);
