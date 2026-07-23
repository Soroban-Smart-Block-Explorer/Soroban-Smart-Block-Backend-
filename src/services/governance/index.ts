/**
 * src/services/governance/index.ts
 *
 * Strategy registry + public surface of the governance services
 * (docs/governance-framework.md §3). Adding a governance model =
 * one strategy file + one registry entry.
 */
import type { VotingModel, VotingStrategy } from './types';
import { TokenWeightedStrategy } from './strategies/token-weighted';
import { QuadraticStrategy } from './strategies/quadratic';
import { ConvictionStrategy } from './strategies/conviction';
import { MultisigStrategy } from './strategies/multisig';

const REGISTRY: Record<VotingModel, VotingStrategy> = {
  token_based: new TokenWeightedStrategy(),
  quadratic: new QuadraticStrategy(),
  conviction: new ConvictionStrategy(),
  multisig: new MultisigStrategy(),
};

export function getStrategy(model: string): VotingStrategy {
  const strategy = REGISTRY[model as VotingModel];
  if (!strategy) {
    throw new Error(`Unknown governance model: ${model}`);
  }
  return strategy;
}

export function supportedModels(): VotingModel[] {
  return Object.keys(REGISTRY) as VotingModel[];
}

export * from './types';
export * from './proposal-lifecycle';
export * from './delegation';
export * from './treasury';
export { TokenWeightedStrategy } from './strategies/token-weighted';
export { QuadraticStrategy, DEFAULT_VOICE_CREDITS } from './strategies/quadratic';
export {
  ConvictionStrategy,
  convictionNow,
  convictionThreshold,
  decayFactor,
  DEFAULT_HALF_LIFE_LEDGERS,
} from './strategies/conviction';
export { MultisigStrategy } from './strategies/multisig';
