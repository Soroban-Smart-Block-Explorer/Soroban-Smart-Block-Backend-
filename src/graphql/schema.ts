export const typeDefs = `#graphql
  # ── Federation ─────────────────────────────────────────────────────
  extend schema
    @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@shareable", "@provides", "@external"])

  # ── Scalars ────────────────────────────────────────────────────────
  scalar DateTime
  scalar JSON
  scalar Cursor

  # ── Page metadata ──────────────────────────────────────────────────
  interface Page {
    hasNext: Boolean!
    nextCursor: Cursor
  }

  # ── Ledger ─────────────────────────────────────────────────────────
  type Ledger @key(fields: "sequence") {
    sequence: Int!
    hash: String!
    closeTime: DateTime!
    txCount: Int!
    transactions(limit: Int = 20, cursor: Cursor): TransactionPage!
    events(limit: Int = 20, cursor: Cursor): EventPage!
  }

  # ── Transaction ────────────────────────────────────────────────────
  type Transaction @key(fields: "hash") {
    hash: ID!
    ledgerSequence: Int!
    ledgerCloseTime: DateTime!
    sourceAccount: String!
    contractAddress: String
    functionName: String
    functionArgs: JSON
    status: String!
    humanReadable: String
    feeCharged: String
    sorobanResources: JSON
    failureReason: String
    ledger: Ledger
    contract: Contract
    events: [Event!]
  }

  type TransactionPage implements Page {
    data: [Transaction!]!
    hasNext: Boolean!
    nextCursor: Cursor
  }

  # ── Event ──────────────────────────────────────────────────────────
  type Event @key(fields: "id") {
    id: ID!
    transactionHash: String!
    contractAddress: String!
    eventType: String!
    topicSymbol: String
    topics: JSON!
    data: JSON!
    decoded: JSON
    ledgerSequence: Int!
    ledgerCloseTime: DateTime!
    ledger: Ledger
    transaction: Transaction
    contract: Contract
  }

  type EventPage implements Page {
    data: [Event!]!
    hasNext: Boolean!
    nextCursor: Cursor
  }

  # ── Contract ───────────────────────────────────────────────────────
  type Contract @key(fields: "address") {
    address: ID!
    name: String
    description: String
    abi: JSON
    functionSignatures: JSON
    isToken: Boolean!
    tokenSymbol: String
    tokenName: String
    tokenDecimals: Int
    wasmHash: String
    isVerified: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime!
    transactions(limit: Int = 20, cursor: Cursor): TransactionPage
    events(limit: Int = 20, cursor: Cursor): EventPage
    functionStats: [FunctionStat!]
  }

  type FunctionStat {
    functionName: String!
    count: Int!
    lastInvoked: DateTime
  }

  # ── Token ──────────────────────────────────────────────────────────
  type Token @key(fields: "address") {
    address: ID!
    name: String
    symbol: String
    decimals: Int
    contract: Contract!
    transfers(limit: Int = 50): [Event!]
  }

  type TokenPage implements Page {
    data: [Token!]!
    hasNext: Boolean!
    nextCursor: Cursor
  }

  # ── Wallet ─────────────────────────────────────────────────────────
  type Wallet @key(fields: "address") {
    address: ID!
    sorobanTxCount: Int!
    firstActivity: DateTime
    lastActivity: DateTime
    transactions(limit: Int = 20, cursor: Cursor): TransactionPage
    events(limit: Int = 20, cursor: Cursor): EventPage
    contracts(limit: Int = 50): [Contract!]
  }

  # ── Alert ──────────────────────────────────────────────────────────
  type Alert {
    id: ID!
    severity: String!
    title: String!
    description: String
    txHash: String
    contractAddress: String
    createdAt: DateTime!
  }

  # ── Query ──────────────────────────────────────────────────────────
  type Query {
    """Fetch a single transaction by hash"""
    transaction(hash: ID!): Transaction

    """Paginated transaction list with optional filters"""
    transactions(
      cursor: Cursor
      limit: Int = 20
      contract: String
      account: String
      status: String
      ledgerMin: Int
      ledgerMax: Int
    ): TransactionPage!

    """Fetch a single event by ID"""
    event(id: ID!): Event

    """Paginated event list with optional filters"""
    events(
      cursor: Cursor
      limit: Int = 20
      contract: String
      type: String
      topic: String
    ): EventPage!

    """Fetch a single contract by address"""
    contract(address: ID!): Contract

    """List all known contracts"""
    contracts(limit: Int = 50): [Contract!]!

    """Fetch a single token by address"""
    token(address: ID!): Token

    """List all known tokens"""
    tokens(cursor: Cursor, limit: Int = 20): TokenPage!

    """Fetch a wallet by Stellar address"""
    wallet(address: ID!): Wallet

    """Fetch a single ledger by sequence"""
    ledger(sequence: Int!): Ledger
  }

  # ── Subscriptions ──────────────────────────────────────────────────
  type Subscription {
    """Subscribe to new transactions, optionally filtered by contract or account"""
    transactionAdded(contract: String, account: String): Transaction!

    """Subscribe to new events, optionally filtered by contract, event type, or topic"""
    eventEmitted(contract: String, eventType: String, topic: String): Event!

    """Subscribe to security or composability alerts"""
    alertTriggered(severity: String): Alert!
  }
`;
