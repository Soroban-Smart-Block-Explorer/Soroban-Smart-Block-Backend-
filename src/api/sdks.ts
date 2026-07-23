/**
 * GET  /api/v1/sdks                          — list all available SDKs
 * GET  /api/v1/sdks/:language                — SDK details and changelog
 * GET  /api/v1/sdks/:language/:version       — specific version info
 * GET  /api/v1/sdks/:language/:version/examples — code examples
 * GET  /api/v1/sdks/:language/install        — installation instructions
 * GET  /api/v1/sdks/versions                 — API version history
 * GET  /api/v1/sdks/analytics                — download telemetry dashboard
 * POST /api/v1/sdks/generate                 — trigger SDK regeneration (admin)
 * GET  /api/v1/openapi.json                  — OpenAPI 3.1 spec
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createHash } from 'crypto';
import { prismaRead, prismaWrite } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';

export const sdksRouter = Router();

const CURRENT_API_VERSION = '2.1.0';

const SDK_REGISTRY: Record<
  string,
  {
    npm?: string;
    pypi?: string;
    crates?: string;
    go?: string;
    maven?: string;
    nuget?: string;
    spm?: string;
    gradle?: string;
    docs: string;
    platform: string;
  }
> = {
  typescript: {
    npm: '@soroban-explorer/client',
    platform: 'npm',
    docs: 'https://docs.soroban-explorer.io/sdk/typescript',
  },
  python: {
    pypi: 'soroban-explorer-client',
    platform: 'pypi',
    docs: 'https://docs.soroban-explorer.io/sdk/python',
  },
  rust: {
    crates: 'soroban-explorer-client',
    platform: 'crates',
    docs: 'https://docs.soroban-explorer.io/sdk/rust',
  },
  go: {
    go: 'github.com/soroban-explorer/client-go',
    platform: 'go-modules',
    docs: 'https://docs.soroban-explorer.io/sdk/go',
  },
  java: {
    maven: 'com.soroban.explorer:client',
    platform: 'maven',
    docs: 'https://docs.soroban-explorer.io/sdk/java',
  },
  kotlin: {
    gradle: 'io.github.soroban-explorer:client',
    platform: 'maven',
    docs: 'https://docs.soroban-explorer.io/sdk/kotlin',
  },
  swift: {
    spm: 'soroban-explorer-client',
    platform: 'spm',
    docs: 'https://docs.soroban-explorer.io/sdk/swift',
  },
  csharp: {
    nuget: 'SorobanExplorer.Client',
    platform: 'nuget',
    docs: 'https://docs.soroban-explorer.io/sdk/csharp',
  },
};

const INSTALL_INSTRUCTIONS: Record<string, string[]> = {
  typescript: [
    'npm install @soroban-explorer/client',
    '# or',
    'yarn add @soroban-explorer/client',
    'pnpm add @soroban-explorer/client',
  ],
  python: ['pip install soroban-explorer-client', '# or', 'poetry add soroban-explorer-client'],
  rust: [
    'cargo add soroban-explorer-client',
    '# or add to Cargo.toml:',
    '[dependencies]',
    'soroban-explorer-client = "2.1.0"',
  ],
  go: ['go get github.com/soroban-explorer/client-go@v2.1.0'],
  java: [
    '<!-- Maven -->',
    '<dependency>',
    '  <groupId>com.soroban.explorer</groupId>',
    '  <artifactId>client</artifactId>',
    '  <version>2.1.0</version>',
    '</dependency>',
  ],
  kotlin: ['// Gradle', 'implementation("io.github.soroban-explorer:client:2.1.0")'],
  swift: [
    '// Package.swift',
    '.package(url: "https://github.com/soroban-explorer/client-swift", from: "2.1.0")',
  ],
  csharp: [
    'dotnet add package SorobanExplorer.Client --version 2.1.0',
    '# or in .csproj:',
    '<PackageReference Include="SorobanExplorer.Client" Version="2.1.0" />',
  ],
};

const CODE_EXAMPLES: Record<string, Record<string, string>> = {
  typescript: {
    'get-transactions': `import { SorobanClient } from '@soroban-explorer/client';

const client = new SorobanClient({ apiKey: 'YOUR_API_KEY' });

const txs = await client.transactions.list({ contractAddress: 'C...' });
console.log(txs.data);`,
    'subscribe-events': `const ws = client.events.subscribe({ contractAddress: 'C...' });
ws.on('event', (event) => console.log(event));`,
    'get-gas-profile': `const gas = await client.gas.getContractProfile('C...');
console.log(gas.summary.avgFee, gas.efficiencyScore);`,
  },
  python: {
    'get-transactions': `from soroban_explorer import SorobanClient

client = SorobanClient(api_key="YOUR_API_KEY")

txs = await client.transactions.list(contract_address="C...")
print(txs.data)`,
    'subscribe-events': `async for event in client.events.subscribe(contract_address="C..."):
    print(event)`,
    'get-gas-profile': `gas = await client.gas.get_contract_profile("C...")
print(gas.summary.avg_fee, gas.efficiency_score)`,
  },
  rust: {
    'get-transactions': `use soroban_explorer_client::SorobanClient;

let client = SorobanClient::new("YOUR_API_KEY");
let txs = client.transactions().list(contract_address: "C...").await?;
println!("{:?}", txs.data);`,
    'get-gas-profile': `let gas = client.gas().contract_profile("C...").await?;
println!("{} efficiency: {}", gas.summary.avg_fee, gas.efficiency_score);`,
  },
  go: {
    'get-transactions': `client := soroban.NewClient("YOUR_API_KEY")
txs, err := client.Transactions.List(ctx, &soroban.ListParams{ContractAddress: "C..."})
if err != nil { log.Fatal(err) }
fmt.Println(txs.Data)`,
  },
};

// ── GET /sdks ─────────────────────────────────────────────────────────────────

sdksRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const versions = await prismaRead.sdkVersion.findMany({
      where: { isDeprecated: false },
      orderBy: { publishedAt: 'desc' },
    });

    const versionMap = new Map<string, { version: string; downloadCount: number }>();
    for (const v of versions) {
      if (!versionMap.has(v.language)) {
        versionMap.set(v.language, { version: v.version, downloadCount: v.downloadCount });
      }
    }

    const sdks = Object.entries(SDK_REGISTRY).map(([lang, info]) => {
      const versionInfo = versionMap.get(lang);
      return {
        language: lang,
        version: versionInfo?.version ?? CURRENT_API_VERSION,
        downloadCount: versionInfo?.downloadCount ?? 0,
        ...info,
      };
    });

    res.json({
      sdks,
      spec: {
        url: '/api/v1/openapi.json',
        version: CURRENT_API_VERSION,
        postmanUrl: '/api/v1/postman.json',
      },
    });
  }),
);

// ── GET /sdks/versions ────────────────────────────────────────────────────────

sdksRouter.get(
  '/versions',
  asyncHandler(async (_req: Request, res: Response) => {
    const versions = await prismaRead.sdkVersion.findMany({
      orderBy: { publishedAt: 'desc' },
      take: 100,
    });

    res.json({ versions, currentApiVersion: CURRENT_API_VERSION });
  }),
);

// ── GET /sdks/analytics ───────────────────────────────────────────────────────

sdksRouter.get(
  '/analytics',
  asyncHandler(async (_req: Request, res: Response) => {
    const downloads = await prismaRead.sdkDownload.findMany({
      orderBy: { downloadedAt: 'desc' },
      take: 10000,
    });

    const byLanguage: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    for (const d of downloads) {
      byLanguage[d.language] = (byLanguage[d.language] ?? 0) + 1;
      const day = d.downloadedAt.toISOString().slice(0, 10);
      byDay[day] = (byDay[day] ?? 0) + 1;
    }

    const versions = await prismaRead.sdkVersion.findMany({
      orderBy: { publishedAt: 'desc' },
      take: 50,
    });

    const versionAdoption = versions.map((v) => ({
      language: v.language,
      version: v.version,
      downloadCount: v.downloadCount,
      isDeprecated: v.isDeprecated,
      publishedAt: v.publishedAt,
    }));

    res.json({
      totalDownloads: downloads.length,
      byLanguage,
      downloadsOverTime: Object.entries(byDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({ date, count })),
      versionAdoption,
    });
  }),
);

// ── POST /sdks/generate ───────────────────────────────────────────────────────

const generateSchema = z.object({
  languages: z.array(z.string()).optional(),
  version: z.string().optional(),
});

sdksRouter.post(
  '/generate',
  asyncHandler(async (req: Request, res: Response) => {
    const body = generateSchema.parse(req.body);
    const targetLanguages = body.languages ?? Object.keys(SDK_REGISTRY);
    const version = body.version ?? CURRENT_API_VERSION;

    const created = await Promise.all(
      targetLanguages.map(async (lang) => {
        const existing = await prismaRead.sdkVersion.findUnique({
          where: { language_version: { language: lang, version } },
        });
        if (existing) return existing;
        return prismaWrite.sdkVersion.create({
          data: {
            language: lang,
            version,
            apiVersion: CURRENT_API_VERSION,
            changelog: `Auto-generated SDK v${version} for ${lang}`,
          },
        });
      }),
    );

    res.status(201).json({
      message: `SDK generation queued for ${targetLanguages.length} languages`,
      languages: targetLanguages,
      version,
      sdkVersions: created,
    });
  }),
);

// ── GET /sdks/:language/install ───────────────────────────────────────────────

sdksRouter.get(
  '/:language/install',
  asyncHandler(async (req: Request, res: Response) => {
    const { language } = req.params;

    if (!SDK_REGISTRY[language]) {
      return res.status(404).json({ error: `Unknown language: ${language}` });
    }

    const instructions = INSTALL_INSTRUCTIONS[language] ?? [];
    res.json({
      language,
      instructions,
      registry: SDK_REGISTRY[language],
    });
  }),
);

// ── GET /sdks/:language/:version/examples ─────────────────────────────────────

sdksRouter.get(
  '/:language/:version/examples',
  asyncHandler(async (req: Request, res: Response) => {
    const { language, version } = req.params;

    if (!SDK_REGISTRY[language]) {
      return res.status(404).json({ error: `Unknown language: ${language}` });
    }

    const examples = CODE_EXAMPLES[language] ?? {};
    res.json({
      language,
      version,
      examples: Object.entries(examples).map(([name, code]) => ({ name, code })),
    });
  }),
);

// ── GET /sdks/:language/:version ──────────────────────────────────────────────

sdksRouter.get(
  '/:language/:version',
  asyncHandler(async (req: Request, res: Response) => {
    const { language, version } = req.params;

    if (!SDK_REGISTRY[language]) {
      return res.status(404).json({ error: `Unknown language: ${language}` });
    }

    const sdkVersion = await prismaRead.sdkVersion.findUnique({
      where: { language_version: { language, version } },
    });

    // Record download
    await prismaWrite.sdkDownload.create({
      data: {
        language,
        version,
        platform: SDK_REGISTRY[language]?.platform,
        userAgent: req.headers['user-agent'],
        ipHash: createHash('sha256')
          .update(req.ip ?? '')
          .digest('hex')
          .slice(0, 16),
      },
    });

    if (sdkVersion) {
      await prismaWrite.sdkVersion.update({
        where: { id: sdkVersion.id },
        data: { downloadCount: { increment: 1 } },
      });
    }

    res.json({
      language,
      version,
      registry: SDK_REGISTRY[language],
      details: sdkVersion,
      examples: CODE_EXAMPLES[language] ?? {},
      install: INSTALL_INSTRUCTIONS[language] ?? [],
    });
  }),
);

// ── GET /sdks/:language ───────────────────────────────────────────────────────

sdksRouter.get(
  '/:language',
  asyncHandler(async (req: Request, res: Response) => {
    const { language } = req.params;

    if (!SDK_REGISTRY[language]) {
      return res.status(404).json({ error: `Unknown language: ${language}` });
    }

    const versions = await prismaRead.sdkVersion.findMany({
      where: { language },
      orderBy: { publishedAt: 'desc' },
      take: 20,
    });

    res.json({
      language,
      registry: SDK_REGISTRY[language],
      currentVersion: CURRENT_API_VERSION,
      versions,
      install: INSTALL_INSTRUCTIONS[language] ?? [],
      examples: CODE_EXAMPLES[language] ?? {},
    });
  }),
);

// ── GET /openapi.json ─────────────────────────────────────────────────────────

export const openApiSpecRouter = Router();

openApiSpecRouter.get(
  '/openapi.json',
  asyncHandler(async (_req: Request, res: Response) => {
    const latest = await prismaRead.apiSpecSnapshot.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    if (latest) {
      return res.json(latest.spec);
    }

    const baseSpec = {
      openapi: '3.1.0',
      info: {
        title: 'Soroban Block Explorer API',
        version: CURRENT_API_VERSION,
        description: 'REST API for the Soroban Smart Block Explorer',
        contact: { email: 'api@soroban-explorer.io' },
      },
      servers: [{ url: '/api/v1', description: 'Production' }],
      tags: [
        { name: 'Transactions', description: 'Soroban transactions' },
        { name: 'Contracts', description: 'Smart contracts' },
        { name: 'Tokens', description: 'SEP-41 tokens' },
        { name: 'Events', description: 'Contract events' },
        { name: 'Gas', description: 'Gas cost analytics' },
        { name: 'SDKs', description: 'Client SDK management' },
        { name: 'TokenHolders', description: 'Token holder analytics' },
        { name: 'Network', description: 'Network stats' },
      ],
      paths: {
        '/gas/contract/{address}': {
          get: {
            tags: ['Gas'],
            summary: 'Full gas profile for a contract',
            parameters: [
              { name: 'address', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'Gas profile' } },
          },
        },
        '/gas/network': {
          get: {
            tags: ['Gas'],
            summary: 'Network-wide gas statistics',
            responses: { '200': { description: 'Network gas stats' } },
          },
        },
        '/sdks': {
          get: {
            tags: ['SDKs'],
            summary: 'List all available SDKs',
            responses: { '200': { description: 'SDK list' } },
          },
        },
        '/token-holders/{address}/holders': {
          get: {
            tags: ['TokenHolders'],
            summary: 'List token holders',
            parameters: [
              { name: 'address', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'Holder list' } },
          },
        },
        '/token-holders/{address}/concentration': {
          get: {
            tags: ['TokenHolders'],
            summary: 'Concentration metrics (Nakamoto, HHI, Gini)',
            parameters: [
              { name: 'address', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'Concentration metrics' } },
          },
        },
      },
      components: {
        securitySchemes: {
          ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        },
      },
    };

    const specStr = JSON.stringify(baseSpec);
    const hash = createHash('sha256').update(specStr).digest('hex');

    await prismaWrite.apiSpecSnapshot.upsert({
      where: { version: CURRENT_API_VERSION },
      create: { version: CURRENT_API_VERSION, spec: baseSpec, hash },
      update: { spec: baseSpec, hash },
    });

    res.json(baseSpec);
  }),
);
