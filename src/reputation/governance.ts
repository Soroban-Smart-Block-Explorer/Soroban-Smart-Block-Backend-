import { toNumber } from './score';

export interface VotingAccount {
  address: string;
  balance: string | number;
}

export interface Delegation {
  delegator: string;
  delegatee: string;
  amount?: string | number;
}

export interface EffectiveVotingPower {
  address: string;
  ownPower: number;
  delegatedIn: number;
  delegatedOut: number;
  effectivePower: number;
}

export function calculateQuadraticVotingPower(balance: string | number): number {
  const numeric = Math.max(0, toNumber(balance, 0));
  return round(Math.sqrt(numeric));
}

export function calculateDelegatedVotingPower(
  accounts: VotingAccount[],
  delegations: Delegation[],
): EffectiveVotingPower[] {
  const ownPower = new Map(
    accounts.map((account) => [account.address, calculateQuadraticVotingPower(account.balance)]),
  );
  const delegatedIn = new Map<string, number>();
  const delegatedOut = new Map<string, number>();

  for (const delegation of delegations) {
    const amount =
      delegation.amount === undefined || delegation.amount === null
        ? (ownPower.get(delegation.delegator) ?? 0)
        : toNumber(delegation.amount, 0);
    delegatedIn.set(delegation.delegatee, (delegatedIn.get(delegation.delegatee) ?? 0) + amount);
    delegatedOut.set(delegation.delegator, (delegatedOut.get(delegation.delegator) ?? 0) + amount);
  }

  const addresses = Array.from(
    new Set([
      ...accounts.map((account) => account.address),
      ...delegations.flatMap((item) => [item.delegator, item.delegatee]),
    ]),
  ).sort();
  return addresses
    .map((address) => {
      const own = ownPower.get(address) ?? 0;
      const incoming = delegatedIn.get(address) ?? 0;
      const outgoing = delegatedOut.get(address) ?? 0;
      return {
        address,
        ownPower: round(own),
        delegatedIn: round(incoming),
        delegatedOut: round(outgoing),
        effectivePower: round(own + incoming - outgoing),
      };
    })
    .sort((a, b) => b.effectivePower - a.effectivePower || a.address.localeCompare(b.address));
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}
