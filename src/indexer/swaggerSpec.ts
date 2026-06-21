import swaggerJsdoc from 'swagger-jsdoc';
import path from 'path';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Soroban Smart Block Explorer API',
      version: '1.0.0',
      description: 'Human-readable Soroban contract explorer. Decodes raw XDR into plain English.',
    },
    // TODO(#251): `servers` base is already /api/v1, but route @swagger paths
    // also include /api/v1 (matching alerts.ts), so rendered URLs are duplicated.
    // Kept consistent for now — raise with maintainers before changing either side.
    servers: [{ url: '/api/v1', description: 'API v1' }],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description:
            'Optional API key. Tiers: public (100 req/min), developer (300 req/min), premium (1000 req/min).',
        },
      },
      schemas: {
        StorageEfficiencyLog: {
          type: 'object',
          properties: {
            transactionHash: { type: 'string' },
            contractAddress: { type: 'string', nullable: true },
            ledgerSequence: { type: 'integer' },
            readOnlyKeys: {
              type: 'integer',
              description: 'Number of declared read-only footprint keys',
            },
            readWriteKeys: {
              type: 'integer',
              description: 'Number of declared read-write footprint keys',
            },
            footprintBytes: {
              type: 'integer',
              description: 'Total declared byte budget (rent-paying storage)',
            },
            actualReadBytes: { type: 'integer', description: 'Actual bytes read during execution' },
            actualWriteBytes: {
              type: 'integer',
              description: 'Actual bytes written during execution',
            },
            unusedBytes: {
              type: 'integer',
              description: 'Unutilised storage bytes (footprintBytes - actualTotal)',
            },
            efficiencyPct: { type: 'number', description: 'Storage efficiency percentage (0–100)' },
          },
        },
        WebhookSubscription: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            url: { type: 'string', format: 'uri' },
            contractAddress: { type: 'string', nullable: true },
            eventType: { type: 'string', nullable: true },
            topicSymbol: { type: 'string', nullable: true },
            active: { type: 'boolean' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        // Shared error envelope returned by route handlers, e.g. { error: "..." }.
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              description: 'Human-readable error message',
              // Neutral fallback; each error response overrides this with a
              // response-level example reflecting that endpoint's real message.
              example: 'Bad request',
            },
          },
        },
        // Core entity: a decoded Soroban contract event (full record).
        Event: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              example: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566-AAAADwAAAAh0cmFuc2Zlcg==',
            },
            transactionHash: {
              type: 'string',
              example: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566',
            },
            contractAddress: {
              type: 'string',
              example: 'CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5',
            },
            eventType: {
              type: 'string',
              description: 'transfer | swap | mint | burn | custom',
              example: 'transfer',
            },
            topicSymbol: {
              type: 'string',
              nullable: true,
              description: 'First topic decoded as a symbol (e.g. "transfer", "mint_pass")',
              example: 'transfer',
            },
            topics: {
              type: 'array',
              items: { type: 'string' },
              description: 'Raw event topics (base64-encoded XDR)',
              example: ['AAAADwAAAAh0cmFuc2Zlcg==', 'AAAAEgAAAAAAAAAAjbb31xRk1h0='],
            },
            data: {
              type: 'object',
              description: 'Raw event data, wrapped as { raw: <base64-encoded XDR> }',
              properties: { raw: { type: 'string', example: 'AAAACgAAAAAAAAAAAAAAADuaygA=' } },
              example: { raw: 'AAAACgAAAAAAAAAAAAAAADuaygA=' },
            },
            decoded: {
              type: 'object',
              nullable: true,
              description: 'Human-readable decoded event payload',
              example: {
                from: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI',
                to: 'CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5',
                amount: '1000000000',
              },
            },
            ledgerSequence: { type: 'integer', example: 3168075 },
            ledgerCloseTime: { type: 'string', format: 'date-time', example: '2026-06-19T07:24:26.000Z' },
            compacted: {
              type: 'boolean',
              description: 'True once the event is rolled into a SettlementBatchSummary (#220)',
              example: false,
            },
            createdAt: { type: 'string', format: 'date-time', example: '2026-06-19T07:24:27.000Z' },
          },
        },
        // Core entity: an indexed Soroban transaction, as projected by the API
        // handler's `select` (TX_SELECT). Field types follow the Transaction model
        // in prisma/schema.prisma; columns the handler omits (id, rawXdr,
        // flashLoanAlert, reentrantAlert, createdAt) are intentionally excluded so
        // that $ref-ing this schema from both routes stays accurate.
        Transaction: {
          type: 'object',
          properties: {
            hash: {
              type: 'string',
              example: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566',
            },
            ledgerSequence: { type: 'integer', example: 3168075 },
            ledgerCloseTime: { type: 'string', format: 'date-time', example: '2026-06-19T07:24:26.000Z' },
            sourceAccount: {
              type: 'string',
              example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI',
            },
            contractAddress: {
              type: 'string',
              nullable: true,
              example: 'CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5',
            },
            functionName: { type: 'string', nullable: true, example: 'swap' },
            functionArgs: {
              type: 'object',
              nullable: true,
              description: 'Decoded function arguments (key/value map)',
              example: { amount: '1000000000', token_in: 'USDC', token_out: 'XLM' },
            },
            status: { type: 'string', description: 'success | failed', example: 'success' },
            humanReadable: {
              type: 'string',
              nullable: true,
              description: 'Plain-English summary, e.g. "Address X swapped 100 USDC → 98.7 XLM"',
              example: 'GBZX...swapped 100 USDC for 98.7 XLM on StellarSwap',
            },
            feeCharged: {
              type: 'string',
              nullable: true,
              description: 'Fee charged, in stroops',
              example: '100',
            },
            sorobanResources: {
              type: 'object',
              nullable: true,
              description: '#48: CPU, memory, and ledger footprint metrics',
              example: { cpuInstructions: 24500000, memoryBytes: 1048576, readBytes: 4096, writeBytes: 512 },
            },
            failureReason: {
              type: 'string',
              nullable: true,
              description: '#49: human-readable failure explanation',
              example: null,
            },
            freezeViolation: {
              type: 'boolean',
              description: 'CAP-0077: transaction touches a consensus-frozen ledger key',
              example: false,
            },
          },
        },
        // Core entity: a registered/indexed Soroban contract (full record).
        // Field types follow the Contract model in prisma/schema.prisma.
        Contract: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'clz9q1x4t0000s6h2abcd1234' },
            address: { type: 'string', example: 'CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5' },
            name: { type: 'string', nullable: true, example: 'USD Coin' },
            description: { type: 'string', nullable: true, example: 'USDC stablecoin token contract' },
            abi: {
              type: 'object',
              nullable: true,
              description: 'ABI-like metadata: functions, events, types',
              example: {
                functions: [
                  { name: 'transfer', inputs: [{ name: 'to', type: 'Address' }, { name: 'amount', type: 'i128' }] },
                ],
              },
            },
            functionSignatures: {
              type: 'array',
              nullable: true,
              items: { type: 'object' },
              description: 'Decoded function signatures, e.g. [{ name, inputs, outputs }]',
              example: [{ name: 'transfer', inputs: ['Address', 'i128'], outputs: [] }],
            },
            isToken: { type: 'boolean', example: true },
            tokenSymbol: { type: 'string', nullable: true, example: 'USDC' },
            tokenName: { type: 'string', nullable: true, example: 'USD Coin' },
            tokenDecimals: { type: 'integer', nullable: true, example: 7 },
            wasmHash: {
              type: 'string',
              nullable: true,
              description: 'Fuzzy hash of compiled Wasm bytecode for similarity detection',
              example: 'e5f40312233445566778899aabbccddeeff00112233445566778899aabbccddee',
            },
            isVerified: { type: 'boolean', example: true },
            createdAt: { type: 'string', format: 'date-time', example: '2026-06-19T07:24:26.000Z' },
            updatedAt: { type: 'string', format: 'date-time', example: '2026-06-19T07:24:26.000Z' },
          },
        },
        // Token summary: the token-specific fields of a Contract, as returned by
        // GET /tokens. Field types follow the Contract model in prisma/schema.prisma.
        Token: {
          type: 'object',
          properties: {
            address: { type: 'string', example: 'CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5' },
            tokenName: { type: 'string', nullable: true, example: 'USD Coin' },
            tokenSymbol: { type: 'string', nullable: true, example: 'USDC' },
            tokenDecimals: { type: 'integer', nullable: true, example: 7 },
          },
        },
        // Soroban simulation execution trace (TraceResult from trace-engine.ts).
        SimulationTrace: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  seq: { type: 'integer', example: 0 },
                  depth: { type: 'integer', example: 0 },
                  type: {
                    type: 'string',
                    enum: ['host_function', 'event', 'state_change'],
                    example: 'host_function',
                  },
                  function: { type: 'string', example: 'swap' },
                  args: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        type: { type: 'string', example: 'i128' },
                        value: { example: '1000000000' },
                      },
                    },
                    example: [{ type: 'i128', value: '1000000000' }],
                  },
                  gasUsed: { type: 'integer', example: 24500000 },
                  memUsed: { type: 'integer', example: 1048576 },
                  stateChanges: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        key: {
                          type: 'string',
                          example: 'Balance(GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI)',
                        },
                        before: { example: '0' },
                        after: { example: '1000000000' },
                        changeType: { type: 'string', enum: ['write', 'read', 'delete'], example: 'write' },
                      },
                    },
                    example: [
                      { key: 'Balance(GBZX...)', before: '0', after: '1000000000', changeType: 'write' },
                    ],
                  },
                  returnValue: {
                    type: 'object',
                    nullable: true,
                    properties: {
                      type: { type: 'string', example: 'i128' },
                      value: { example: '987000000' },
                    },
                    example: { type: 'i128', value: '987000000' },
                  },
                  error: { type: 'string', nullable: true, example: null },
                },
              },
            },
            totalGas: { type: 'integer', example: 24500000 },
            totalMemory: { type: 'integer', example: 1048576 },
            callGraph: {
              type: 'object',
              properties: {
                nodes: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', example: 'node-0' },
                      contract: {
                        type: 'string',
                        example: 'CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5',
                      },
                      function: { type: 'string', example: 'swap' },
                      gas: { type: 'integer', example: 24500000 },
                      depth: { type: 'integer', example: 0 },
                    },
                  },
                },
                edges: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      from: { type: 'string', example: 'node-0' },
                      to: { type: 'string', example: 'node-1' },
                      type: { type: 'string', enum: ['call', 'return'], example: 'call' },
                    },
                  },
                },
              },
            },
            events: { type: 'array', items: { type: 'object' }, example: [] },
            success: { type: 'boolean', example: true },
            error: { type: 'string', nullable: true, example: null },
          },
        },
        // Simulation failure analysis (RevertAnalysis from revert-analyzer.ts).
        RevertAnalysis: {
          type: 'object',
          properties: {
            errorType: {
              type: 'string',
              enum: ['panic', 'contract_error', 'resource_limit', 'auth_error', 'wasm_error', 'storage_error', 'unknown'],
              example: 'contract_error',
            },
            message: { type: 'string', example: 'Contract call failed: insufficient balance' },
            detail: { type: 'string', nullable: true, example: 'Error(Contract, #3)' },
            callStack: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  depth: { type: 'integer', example: 0 },
                  contractId: {
                    type: 'string',
                    example: 'CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5',
                  },
                  function: { type: 'string', example: 'swap' },
                },
              },
              example: [
                { depth: 0, contractId: 'CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5', function: 'swap' },
              ],
            },
            suggestedFixes: {
              type: 'array',
              items: { type: 'string' },
              example: ['Ensure the account has sufficient balance before calling swap.'],
            },
          },
        },
      },
    },
    security: [{ ApiKeyAuth: [] }],
  },
  // Scan all route files for @swagger JSDoc comments
  apis: [
    path.join(__dirname, '../api/*.ts'),
    path.join(__dirname, '../api/*.js'),
    path.join(__dirname, '../middleware/*.ts'),
    path.join(__dirname, '../middleware/*.js'),
  ],
};

export const swaggerSpec = swaggerJsdoc(options);
