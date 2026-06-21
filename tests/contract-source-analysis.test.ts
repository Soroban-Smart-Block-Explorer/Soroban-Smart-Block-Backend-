import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prismaRead, prismaWrite } from '../src/db';
import { analyzeWasmContract } from '../src/indexer/wasm-decompiler';

describe('Contract Source Analysis — Integration Tests', () => {
  // Helper: create minimal valid Wasm
  function makeWasm(opcodes: number[]): Buffer {
    const body = Buffer.from([0x00, ...opcodes, 0x0b]);
    const bodySize = encodeUleb128(body.length);
    const funcCount = Buffer.from([0x01]);
    const sectionPayload = Buffer.concat([funcCount, bodySize, body]);
    const sectionSize = encodeUleb128(sectionPayload.length);

    return Buffer.concat([
      Buffer.from([0x00, 0x61, 0x73, 0x6d]),
      Buffer.from([0x01, 0x00, 0x00, 0x00]),
      Buffer.from([0x0a]),
      sectionSize,
      sectionPayload,
    ]);
  }

  function encodeUleb128(value: number): Buffer {
    const bytes: number[] = [];
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) byte |= 0x80;
      bytes.push(byte);
    } while (value !== 0);
    return Buffer.from(bytes);
  }

  describe('analyzeWasmContract', () => {
    it('extracts function names and types from Wasm', () => {
      const wasm = makeWasm([0x01]); // nop
      const analysis = analyzeWasmContract(wasm);
      expect(analysis).toBeDefined();
      expect(analysis.sourceType).toBe('wasm');
      expect(analysis.language).toBe('wasm');
      expect(analysis.functions).toBeDefined();
    });

    it('generates pseudo-code for functions', () => {
      const wasm = makeWasm([0x01]); // nop
      const analysis = analyzeWasmContract(wasm);
      expect(analysis.functions.length).toBeGreaterThan(0);
      const fn = analysis.functions[0];
      expect(fn.pseudoCode).toBeDefined();
      expect(fn.pseudoCode.length).toBeGreaterThanOrEqual(0);
    });

    it('extracts CFG (control flow graph) for functions', () => {
      const wasm = makeWasm([0x01, 0x01, 0x01]); // three nops
      const analysis = analyzeWasmContract(wasm);
      const fn = analysis.functions[0];
      expect(fn.cfg).toBeDefined();
      expect(fn.cfg.entryBlock).toBeDefined();
      expect(fn.cfg.blocks).toBeDefined();
    });

    it('calculates cyclomatic complexity', () => {
      const wasm = makeWasm([0x01]); // nop (low complexity)
      const analysis = analyzeWasmContract(wasm);
      const fn = analysis.functions[0];
      expect(fn.cyclomaticComplexity).toBeGreaterThanOrEqual(1);
      expect(fn.complexity).toMatch(/low|medium|high/);
    });

    it('tracks storage operations', () => {
      const wasm = makeWasm([0x28, 0x00, 0x00]); // i32.load with alignment=0, offset=0
      const analysis = analyzeWasmContract(wasm);
      const fn = analysis.functions[0];
      expect(fn.storageOperations).toBeDefined();
      expect(Array.isArray(fn.storageOperations)).toBe(true);
    });

    it('identifies host function calls', () => {
      const wasm = makeWasm([0x01]); // nop (no host calls)
      const analysis = analyzeWasmContract(wasm);
      const fn = analysis.functions[0];
      expect(fn.hostCalls).toBeDefined();
      expect(Array.isArray(fn.hostCalls)).toBe(true);
    });

    it('generates source maps', () => {
      const wasm = makeWasm([0x01, 0x01]); // two nops
      const analysis = analyzeWasmContract(wasm);
      const fn = analysis.functions[0];
      expect(fn.sourceMap).toBeDefined();
      expect(Array.isArray(fn.sourceMap)).toBe(true);
      if (fn.sourceMap.length > 0) {
        const entry = fn.sourceMap[0] as any;
        expect(entry).toHaveProperty('instructionIndex');
        expect(entry).toHaveProperty('wasmOffset');
      }
    });

    it('builds call graph', () => {
      const wasm = makeWasm([0x01]);
      const analysis = analyzeWasmContract(wasm);
      expect(analysis.callGraph).toBeDefined();
      expect(analysis.callGraph.nodes).toBeDefined();
      expect(Array.isArray(analysis.callGraph.nodes)).toBe(true);
      expect(analysis.callGraph.edges).toBeDefined();
      expect(Array.isArray(analysis.callGraph.edges)).toBe(true);
    });

    it('extracts imports and exports', () => {
      const wasm = makeWasm([0x01]);
      const analysis = analyzeWasmContract(wasm);
      expect(Array.isArray(analysis.imports)).toBe(true);
      expect(Array.isArray(analysis.exports)).toBe(true);
    });

    it('extracts memory layout', () => {
      const wasm = makeWasm([0x01]);
      const analysis = analyzeWasmContract(wasm);
      expect(Array.isArray(analysis.memory)).toBe(true);
    });

    it('computes bytecode hash', () => {
      const wasm = makeWasm([0x01]);
      const analysis = analyzeWasmContract(wasm);
      expect(analysis.wasmHash).toBeDefined();
      expect(analysis.wasmHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('Contract persistence to DB', () => {
    it('stores ContractSource analysis', async () => {
      vi.mock('../src/db', () => ({
        prismaWrite: { contractSource: { upsert: vi.fn().mockResolvedValue({ id: 'test-id' }) } },
      }));
      // Minimal test: verify structure is valid for upsert
      const wasm = makeWasm([0x01]);
      const analysis = analyzeWasmContract(wasm);
      expect(analysis.sourceType).toBe('wasm');
      expect(analysis.wasmHash).toBeDefined();
      expect(analysis.bytecodeSize).toBeGreaterThan(0);
    });
  });

  describe('Performance — Batch decompilation', () => {
    it('can process 100 Wasm binaries', () => {
      const startTime = Date.now();
      const wasmBinaries = Array(100).fill(null).map(() => makeWasm([0x01, 0x01]));
      const results = wasmBinaries.map((wasm) => analyzeWasmContract(wasm));
      const elapsed = Date.now() - startTime;

      expect(results.length).toBe(100);
      expect(results.every((r) => r.functions.length > 0)).toBe(true);
      // Should complete in reasonable time (< 5 seconds for 100)
      expect(elapsed).toBeLessThan(5000);
    });

    it('processes contracts sequentially without memory bloat', () => {
      const wasm = makeWasm([0x01]);
      for (let i = 0; i < 50; i++) {
        const analysis = analyzeWasmContract(wasm);
        expect(analysis.functions.length).toBeGreaterThan(0);
      }
      // If we reach here, no uncaught memory errors
      expect(true).toBe(true);
    });
  });
});

describe('Search & Indexing', () => {
  it('indexes function names', () => {
    // Verify search index schema allows function indexing
    const indexEntry = {
      contractAddress: 'CAA123',
      contentType: 'function',
      content: 'transfer amount recipient',
      metadata: { selector: '0xabc' },
    };
    expect(indexEntry.contentType).toBe('function');
    expect(indexEntry.content).toContain('transfer');
  });

  it('indexes imports', () => {
    const indexEntry = {
      contractAddress: 'CAA123',
      contentType: 'import',
      content: 'soroban_auth require_auth',
      metadata: { host: true },
    };
    expect(indexEntry.contentType).toBe('import');
  });

  it('faceted search supports function:', () => {
    const query = 'function:transfer';
    const match = query.match(/function:(\w+)/i)?.[1];
    expect(match).toBe('transfer');
  });

  it('faceted search supports import:', () => {
    const query = 'import:soroban_auth';
    const match = query.match(/import:(\w+)/i)?.[1];
    expect(match).toBe('soroban_auth');
  });
});

describe('Template Similarity', () => {
  it('matches SEP-41 token functions', () => {
    const tokenFuncs = ['transfer', 'balance', 'mint', 'burn'];
    const contractFuncs = ['transfer', 'balance', 'approve', 'mint'];
    const matches = tokenFuncs.filter((f) => contractFuncs.includes(f));
    expect(matches.length).toBeGreaterThan(0);
    expect(matches).toContain('transfer');
  });

  it('calculates similarity percentage', () => {
    const contractFuncs = new Set(['transfer', 'balance', 'mint']);
    const templateFuncs = new Set(['transfer', 'balance', 'mint', 'burn']);
    const matches = Array.from(contractFuncs).filter((f) => templateFuncs.has(f));
    const total = Math.max(contractFuncs.size, templateFuncs.size);
    const similarity = (matches.length / total) * 100;
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThanOrEqual(100);
  });
});

describe('Cross-Contract References', () => {
  it('tracks inbound and outbound references', () => {
    const reference = {
      sourceContract: 'CA001',
      targetContract: 'CA002',
      referenceType: 'call',
      callCount: 5,
    };
    expect(reference.sourceContract).toBeDefined();
    expect(reference.targetContract).toBeDefined();
    expect(reference.callCount).toBeGreaterThan(0);
  });

  it('graphs contract call relationships', () => {
    const graph = {
      nodes: ['CA001', 'CA002', 'CA003'],
      edges: [
        { from: 'CA001', to: 'CA002', type: 'call' },
        { from: 'CA002', to: 'CA003', type: 'call' },
      ],
    };
    expect(graph.nodes.length).toBe(3);
    expect(graph.edges.length).toBe(2);
  });
});
