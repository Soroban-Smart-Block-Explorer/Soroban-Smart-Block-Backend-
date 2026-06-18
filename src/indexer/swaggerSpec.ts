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
    servers: [{ url: '/api/v1', description: 'API v1' }],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'Optional API key. Tiers: public (100 req/min), developer (300 req/min), premium (1000 req/min).',
        },
      },
      schemas: {
        StorageEfficiencyLog: {
          type: 'object',
          properties: {
            transactionHash: { type: 'string' },
            contractAddress: { type: 'string', nullable: true },
            ledgerSequence: { type: 'integer' },
            readOnlyKeys: { type: 'integer', description: 'Number of declared read-only footprint keys' },
            readWriteKeys: { type: 'integer', description: 'Number of declared read-write footprint keys' },
            footprintBytes: { type: 'integer', description: 'Total declared byte budget (rent-paying storage)' },
            actualReadBytes: { type: 'integer', description: 'Actual bytes read during execution' },
            actualWriteBytes: { type: 'integer', description: 'Actual bytes written during execution' },
            unusedBytes: { type: 'integer', description: 'Unutilised storage bytes (footprintBytes - actualTotal)' },
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
