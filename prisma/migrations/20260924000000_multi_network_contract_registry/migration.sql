-- Multi-network contract registry
-- Stores network-keyed addresses, ABI/version metadata, and same-protocol
-- linkage hints for contracts deployed on more than one Stellar network.

CREATE TABLE "_contract_networks" (
  "id"                 TEXT         NOT NULL,
  "address"            VARCHAR(56)  NOT NULL,
  "network"            VARCHAR(32)  NOT NULL DEFAULT 'testnet',
  "contract_id"        TEXT         NOT NULL,
  "abi"                JSONB,
  "abi_version"        VARCHAR(64),
  "abi_hash"           VARCHAR(64),
  "wasm_hash"          VARCHAR(64),
  "version"            VARCHAR(64),
  "protocol_key"       VARCHAR(128),
  "is_canonical"       BOOLEAN      NOT NULL DEFAULT false,
  "deployed_at_ledger" INTEGER,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "_contract_networks_pkey" PRIMARY KEY ("id")
);

-- Dedupe on (address, network): an address is only meaningful within a network.
CREATE UNIQUE INDEX "_contract_networks_address_network_key"
  ON "_contract_networks"("address", "network");

-- One deployment per canonical contract per network.
CREATE UNIQUE INDEX "_contract_networks_contract_network_key"
  ON "_contract_networks"("contract_id", "network");

CREATE INDEX "_contract_networks_contract_id_idx" ON "_contract_networks"("contract_id");
CREATE INDEX "_contract_networks_network_idx" ON "_contract_networks"("network");
CREATE INDEX "_contract_networks_protocol_key_idx" ON "_contract_networks"("protocol_key");

ALTER TABLE "_contract_networks"
  ADD CONSTRAINT "_contract_networks_contract_id_fkey"
  FOREIGN KEY ("contract_id") REFERENCES "_contracts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
