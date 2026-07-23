import { classifyContract, ClassificationResult } from './heuristic-classifier';
import { detectAnomalies, AnomalyReport } from './anomaly-detector';
import { analyzeContractWasm, WasmAnalysis } from './wasm-analyzer';
import { getLlmDescription } from './llm-provider';
import { prisma } from '../db';

export interface IntelligenceReport {
  address: string;
  analysis: WasmAnalysis | null;
  classification: ClassificationResult;
  anomalies: AnomalyReport;
  llm: { description: string; provider: string; cost?: number } | null;
  generatedAt: string;
}

const cache = new Map<string, { report: IntelligenceReport; expiresAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

export async function buildIntelligenceReport(
  address: string,
  useLlm = true,
): Promise<IntelligenceReport> {
  const hit = cache.get(address);
  if (hit && hit.expiresAt > Date.now()) return hit.report;

  const analysis = await analyzeContractWasm(address);
  const functionNames = analysis?.rawFunctionNames ?? [];

  const classification = classifyContract(functionNames);
  const anomalies = await detectAnomalies(address, functionNames, analysis?.hasContractSpec ?? false);

  let llm: IntelligenceReport['llm'] = null;
  if (useLlm && functionNames.length > 0) {
    const desc = await getLlmDescription(address, functionNames, classification.category);
    if (desc) llm = { description: desc.description, provider: desc.provider, cost: desc.cost };
  }

  const report: IntelligenceReport = {
    address,
    analysis,
    classification,
    anomalies,
    llm,
    generatedAt: new Date().toISOString(),
  };

  cache.set(address, { report, expiresAt: Date.now() + CACHE_TTL_MS });
  return report;
}

export async function findSimilarContracts(
  address: string,
  myFunctions: string[],
): Promise<{ address: string; name: string | null; similarity: number; sharedFunctions: string[] }[]> {
  const others = await prisma.contract.findMany({
    where: { address: { not: address }, abi: { not: undefined } },
    select: { address: true, name: true, abi: true },
    take: 100,
  });

  return others
    .map((c) => {
      const abi = c.abi as any;
      const otherFns: string[] = Array.isArray(abi?.functions)
        ? abi.functions.map((f: any) => f.name).filter(Boolean)
        : [];
      const shared = myFunctions.filter((f) => otherFns.includes(f));
      const similarity = shared.length / Math.max(1, Math.max(myFunctions.length, otherFns.length));
      return { address: c.address, name: c.name, similarity: Math.round(similarity * 100), sharedFunctions: shared };
    })
    .filter((c) => c.similarity >= 30)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 10);
}
