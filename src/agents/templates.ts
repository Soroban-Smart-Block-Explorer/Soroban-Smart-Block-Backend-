import type { AgentTemplate } from './types';

export const agentTemplates: AgentTemplate[] = [
  {
    id: 'dca',
    name: 'DCA Agent',
    description:
      'Executes dollar-cost-average buys on a schedule. Configurable pair, amount, frequency, and total buys.',
    category: 'trading',
    version: '1.0.0',
    author: 'Soroban Explorer',
    price: '0',
    configSchema: {
      type: 'object',
      properties: {
        pair: {
          type: 'object',
          properties: {
            tokenA: { type: 'string', description: 'Token to buy' },
            tokenB: { type: 'string', description: 'Token to sell' },
          },
          required: ['tokenA', 'tokenB'],
        },
        amountPerBuy: { type: 'string', description: 'Amount of tokenA to buy per execution' },
        totalBuys: {
          type: 'integer',
          description: 'Total number of buys to execute',
          minimum: 1,
          maximum: 1000,
        },
        buysExecuted: { type: 'integer', default: 0 },
        frequencyMinutes: { type: 'integer', description: 'Minutes between buys', minimum: 1 },
        maxSlippagePercent: { type: 'number', description: 'Max slippage tolerance', default: 0.5 },
        targetPrice: {
          type: 'string',
          description: 'Target price for limit-order style DCA (optional)',
        },
      },
      required: ['pair', 'amountPerBuy', 'totalBuys', 'frequencyMinutes'],
    },
    wasmBase64: 'AGFzbQEAAAABEQFAAg==',
    abi: {
      functions: [
        {
          name: 'evaluate',
          inputs: [{ name: 'state', type: 'bytes' }],
          outputs: [{ type: 'bytes' }],
        },
        { name: 'execute', inputs: [{ name: 'action', type: 'bytes' }], outputs: [] },
      ],
    },
    defaultPermissions: [
      {
        capability: 'can_swap',
        agentId: '',
        nonce: '',
        signature: '',
      },
    ],
    defaultLimits: {
      maxGasPerExecution: 50000,
      maxGasPerDay: 500000,
      maxExecutionsPerDay: 100,
      maxStorageBytes: 65536,
      maxConcurrentCalls: 1,
      maxDrawdownPercent: 15,
    },
  },
  {
    id: 'governance',
    name: 'Governance Delegate',
    description:
      'Automatically votes on proposals based on user preferences. Supports majority, delegate, and AI analysis strategies.',
    category: 'governance',
    version: '1.0.0',
    author: 'Soroban Explorer',
    price: '0',
    configSchema: {
      type: 'object',
      properties: {
        strategy: {
          type: 'string',
          enum: ['majority', 'specific_delegates', 'ai_analysis'],
          description: 'Voting strategy',
        },
        delegateAddresses: {
          type: 'array',
          items: { type: 'string' },
          description: 'Delegate addresses to follow (for specific_delegates strategy)',
        },
        voteOnAllProposals: { type: 'boolean', default: true },
        proposalFilter: { type: 'string', description: 'Optional filter for proposals' },
      },
      required: ['strategy'],
    },
    wasmBase64: 'AGFzbQEAAAABEQFAAg==',
    abi: {
      functions: [
        {
          name: 'analyze',
          inputs: [{ name: 'proposal', type: 'bytes' }],
          outputs: [{ type: 'bytes' }],
        },
        { name: 'vote', inputs: [{ name: 'decision', type: 'bytes' }], outputs: [] },
      ],
    },
    defaultPermissions: [
      {
        capability: 'can_vote',
        agentId: '',
        nonce: '',
        signature: '',
      },
    ],
    defaultLimits: {
      maxGasPerExecution: 30000,
      maxGasPerDay: 300000,
      maxExecutionsPerDay: 50,
      maxStorageBytes: 65536,
      maxConcurrentCalls: 1,
      maxDrawdownPercent: 0,
    },
  },
  {
    id: 'yield-optimizer',
    name: 'Yield Optimizer',
    description:
      'Monitors lending pools, auto-compounds rewards, and rebalances based on APY changes.',
    category: 'yield',
    version: '1.0.0',
    author: 'Soroban Explorer',
    price: '99',
    configSchema: {
      type: 'object',
      properties: {
        pools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lending pool contract addresses',
        },
        targetApy: { type: 'number', description: 'Target minimum APY' },
        rebalanceThresholdPercent: {
          type: 'number',
          description: 'APY deviation to trigger rebalance',
        },
        autoCompound: { type: 'boolean', default: true },
      },
      required: ['pools', 'targetApy'],
    },
    wasmBase64: 'AGFzbQEAAAABEQFAAg==',
    abi: {
      functions: [
        {
          name: 'evaluate_pools',
          inputs: [{ name: 'pools', type: 'bytes' }],
          outputs: [{ type: 'bytes' }],
        },
        { name: 'compound', inputs: [{ name: 'pool', type: 'address' }], outputs: [] },
        {
          name: 'rebalance',
          inputs: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
          ],
          outputs: [],
        },
      ],
    },
    defaultPermissions: [
      { capability: 'can_swap', agentId: '', nonce: '', signature: '' },
      { capability: 'can_lend', agentId: '', nonce: '', signature: '' },
    ],
    defaultLimits: {
      maxGasPerExecution: 100000,
      maxGasPerDay: 1000000,
      maxExecutionsPerDay: 50,
      maxStorageBytes: 65536,
      maxConcurrentCalls: 2,
      maxDrawdownPercent: 10,
    },
  },
  {
    id: 'mev-protector',
    name: 'MEV Protector',
    description:
      'Wraps user transactions to prevent frontrunning and sandwich attacks via private mempool submission.',
    category: 'security',
    version: '1.0.0',
    author: 'Soroban Explorer',
    price: '49',
    configSchema: {
      type: 'object',
      properties: {
        privateMempool: { type: 'boolean', default: true },
        tipPercent: { type: 'number', default: 5, description: 'Validator tip percentage' },
        gasStrategy: {
          type: 'string',
          enum: ['aggressive', 'standard', 'conservative'],
          default: 'standard',
        },
        maxWrapGas: { type: 'integer', default: 200000 },
      },
    },
    wasmBase64: 'AGFzbQEAAAABEQFAAg==',
    abi: {
      functions: [
        {
          name: 'wrap_tx',
          inputs: [{ name: 'transaction', type: 'bytes' }],
          outputs: [{ type: 'bytes' }],
        },
        { name: 'submit', inputs: [{ name: 'wrapped', type: 'bytes' }], outputs: [] },
      ],
    },
    defaultPermissions: [{ capability: 'can_transfer', agentId: '', nonce: '', signature: '' }],
    defaultLimits: {
      maxGasPerExecution: 200000,
      maxGasPerDay: 2000000,
      maxExecutionsPerDay: 200,
      maxStorageBytes: 65536,
      maxConcurrentCalls: 2,
      maxDrawdownPercent: 5,
    },
  },
  {
    id: 'stop-loss',
    name: 'Stop-Loss Agent',
    description:
      'Monitors position health and triggers liquidation protection when health factor drops below threshold.',
    category: 'risk',
    version: '1.0.0',
    author: 'Soroban Explorer',
    price: '29',
    configSchema: {
      type: 'object',
      properties: {
        positionContract: { type: 'string', description: 'Lending position contract' },
        positionId: { type: 'string', description: 'Position identifier' },
        healthThreshold: { type: 'number', description: 'Health factor threshold', default: 1.2 },
        swapTargetToken: { type: 'string', description: 'Token to swap to for repayment' },
        maxSlippagePercent: { type: 'number', default: 1 },
      },
      required: ['positionContract', 'positionId', 'swapTargetToken'],
    },
    wasmBase64: 'AGFzbQEAAAABEQFAAg==',
    abi: {
      functions: [
        {
          name: 'check_health',
          inputs: [{ name: 'position', type: 'bytes' }],
          outputs: [{ type: 'bytes' }],
        },
        { name: 'repay', inputs: [{ name: 'params', type: 'bytes' }], outputs: [] },
      ],
    },
    defaultPermissions: [{ capability: 'can_swap', agentId: '', nonce: '', signature: '' }],
    defaultLimits: {
      maxGasPerExecution: 80000,
      maxGasPerDay: 400000,
      maxExecutionsPerDay: 50,
      maxStorageBytes: 65536,
      maxConcurrentCalls: 1,
      maxDrawdownPercent: 30,
    },
  },
  {
    id: 'liquidation-sniper',
    name: 'Liquidation Sniper',
    description:
      'Monitors undercollateralized positions and atomically repays and claims collateral for profit.',
    category: 'trading',
    version: '1.0.0',
    author: 'Soroban Explorer',
    price: '199',
    configSchema: {
      type: 'object',
      properties: {
        targetPools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Target lending pool contracts',
        },
        minProfitPercent: {
          type: 'number',
          default: 2,
          description: 'Minimum profit percentage to act',
        },
        maxGasForTx: { type: 'integer', default: 150000 },
        maxConcurrentLiquidations: { type: 'integer', default: 3 },
      },
      required: ['targetPools'],
    },
    wasmBase64: 'AGFzbQEAAAABEQFAAg==',
    abi: {
      functions: [
        { name: 'scan', inputs: [{ name: 'pools', type: 'bytes' }], outputs: [{ type: 'bytes' }] },
        { name: 'liquidate', inputs: [{ name: 'target', type: 'bytes' }], outputs: [] },
      ],
    },
    defaultPermissions: [
      { capability: 'can_swap', agentId: '', nonce: '', signature: '' },
      { capability: 'can_transfer', agentId: '', nonce: '', signature: '' },
    ],
    defaultLimits: {
      maxGasPerExecution: 150000,
      maxGasPerDay: 1500000,
      maxExecutionsPerDay: 50,
      maxStorageBytes: 65536,
      maxConcurrentCalls: 3,
      maxDrawdownPercent: 25,
    },
  },
  {
    id: 'compliance',
    name: 'Compliance Agent',
    description:
      'Monitors wallet addresses for suspicious activity and auto-freezes if risk score exceeds threshold.',
    category: 'security',
    version: '1.0.0',
    author: 'Soroban Explorer',
    price: '49',
    configSchema: {
      type: 'object',
      properties: {
        riskThreshold: { type: 'number', default: 70, description: 'Risk score threshold (0-100)' },
        monitorAddresses: {
          type: 'array',
          items: { type: 'string' },
          description: 'Addresses to monitor',
        },
        freezeOnAlert: { type: 'boolean', default: true },
        freezeStrategy: {
          type: 'string',
          enum: ['immediate', 'threshold', 'manual'],
          default: 'immediate',
        },
      },
      required: ['monitorAddresses'],
    },
    wasmBase64: 'AGFzbQEAAAABEQFAAg==',
    abi: {
      functions: [
        {
          name: 'screen',
          inputs: [{ name: 'address', type: 'address' }],
          outputs: [{ type: 'bytes' }],
        },
        { name: 'freeze', inputs: [{ name: 'address', type: 'address' }], outputs: [] },
      ],
    },
    defaultPermissions: [],
    defaultLimits: {
      maxGasPerExecution: 50000,
      maxGasPerDay: 500000,
      maxExecutionsPerDay: 200,
      maxStorageBytes: 65536,
      maxConcurrentCalls: 1,
      maxDrawdownPercent: 0,
    },
  },
];

export function getTemplateById(id: string): AgentTemplate | undefined {
  return agentTemplates.find((t) => t.id === id);
}

export function getTemplatesByCategory(category: string): AgentTemplate[] {
  return agentTemplates.filter((t) => t.category === category);
}

export async function seedTemplates(): Promise<void> {
  const { prismaWrite } = await import('../db');

  for (const template of agentTemplates) {
    const existing = await prismaWrite.agentTemplate.findUnique({ where: { id: template.id } });
    if (!existing) {
      await prismaWrite.agentTemplate.create({
        data: {
          id: template.id,
          name: template.name,
          description: template.description,
          category: template.category,
          version: template.version,
          author: template.author,
          price: template.price || 0,
          configSchema: template.configSchema as any,
          wasmBase64: template.wasmBase64,
          abi: template.abi as any,
          defaultPermissions: template.defaultPermissions as any,
          defaultLimits: template.defaultLimits as any,
          isPublished: true,
        },
      });
    }
  }
}
