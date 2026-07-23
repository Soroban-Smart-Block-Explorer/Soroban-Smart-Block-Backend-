import { Prisma } from '@prisma/client';
import { CallOutcome } from './runtime';

export type TemplateId =
  | 'sep41-token'
  | 'constant-product-amm'
  | 'stableswap-amm'
  | 'basic-nft'
  | 'multisig-wallet'
  | 'simple-auction'
  | 'governance-token'
  | 'timelock-controller'
  | 'vesting-contract'
  | 'dex-aggregator'
  | string;

export type TemplateState = Record<string, unknown>;

export interface ExecuteTemplateInput {
  templateId: TemplateId | null | undefined;
  functionName: string;
  args: Record<string, unknown>;
  sourceAccount: string;
  state: TemplateState;
}

export function executeTemplate(input: ExecuteTemplateInput): CallOutcome {
  const { templateId, functionName, args, sourceAccount, state } = input;
  const before = clone(state);
  const next = clone(state);
  const s = next as Record<string, any>;
  const events: unknown[] = [];
  let result: unknown = null;
  let error: string | null = null;

  const type = templateId ?? 'generic';

  if (type === 'sep41-token') {
    const balances = (s.balances ?? {}) as Record<string, string>;
    const amount = toDecimalString(args.amount ?? args.value ?? '0');
    const from = String(args.from ?? sourceAccount);
    const to = String(args.to ?? sourceAccount);

    switch (functionName) {
      case 'initialize':
        s.admin = String(args.admin ?? sourceAccount);
        break;
      case 'mint':
        balances[to] = decimalPlus(balances[to] ?? '0', amount);
        s.totalSupply = decimalPlus(String(s.totalSupply ?? '0'), amount);
        events.push({ type: 'mint', to, amount });
        result = { minted: amount };
        break;
      case 'burn':
        balances[from] = decimalMinus(balances[from] ?? '0', amount);
        s.totalSupply = decimalMinus(String(s.totalSupply ?? '0'), amount);
        events.push({ type: 'burn', from, amount });
        result = { burned: amount };
        break;
      case 'transfer': {
        balances[from] = decimalMinus(balances[from] ?? '0', amount);
        balances[to] = decimalPlus(balances[to] ?? '0', amount);
        events.push({ type: 'transfer', from, to, amount });
        result = { transferred: amount };
        break;
      }
      case 'balance_of':
        result = { balance: balances[String(args.owner ?? sourceAccount)] ?? '0' };
        break;
      case 'pause':
        s.paused = true;
        break;
      case 'unpause':
        s.paused = false;
        break;
      default:
        error = `Unsupported token function ${functionName}`;
        break;
    }

    s.balances = balances;
  } else if (type === 'constant-product-amm' || type === 'stableswap-amm') {
    const reserveA = String(s.reserveA ?? '0');
    const reserveB = String(s.reserveB ?? '0');
    const amountIn = toDecimalString(args.amount_in ?? args.amount ?? '0');
    if (functionName === 'add_liquidity') {
      s.reserveA = decimalPlus(reserveA, toDecimalString(args.amount_a ?? '0'));
      s.reserveB = decimalPlus(reserveB, toDecimalString(args.amount_b ?? '0'));
      result = { reserveA: s.reserveA, reserveB: s.reserveB };
    } else if (functionName === 'get_reserves') {
      result = { reserveA, reserveB };
    } else if (functionName === 'swap') {
      const inputReserve = ensureNumber(amountIn, 0) <= 0 ? '0' : amountIn;
      const output = new Prisma.Decimal(inputReserve).mul(0.97).toFixed();
      s.reserveA = decimalPlus(reserveA, inputReserve);
      s.reserveB = decimalMinus(reserveB, output);
      result = { amountOut: output };
      events.push({ type: 'swap', amountIn: inputReserve, amountOut: output });
    } else {
      error = `Unsupported AMM function ${functionName}`;
    }
  } else if (type === 'basic-nft') {
    const owners = (s.owners ?? {}) as Record<string, string>;
    if (functionName === 'mint') {
      const tokenId = String(args.token_id ?? args.tokenId ?? Object.keys(owners).length + 1);
      owners[tokenId] = String(args.to ?? sourceAccount);
      result = { tokenId, owner: owners[tokenId] };
    } else if (functionName === 'transfer') {
      const tokenId = String(args.token_id ?? args.tokenId);
      owners[tokenId] = String(args.to ?? sourceAccount);
      result = { tokenId, owner: owners[tokenId] };
    } else if (functionName === 'owner_of') {
      const tokenId = String(args.token_id ?? args.tokenId);
      result = { owner: owners[tokenId] ?? null };
    } else {
      error = `Unsupported NFT function ${functionName}`;
    }
    s.owners = owners;
  } else if (
    type === 'multisig-wallet' ||
    type === 'governance-token' ||
    type === 'timelock-controller' ||
    type === 'vesting-contract' ||
    type === 'dex-aggregator'
  ) {
    s.lastFunction = functionName;
    s.lastArgs = clone(args);
    result = { ok: true, template: type };
  } else {
    s.lastFunction = functionName;
    s.lastArgs = clone(args);
    result = { echoed: true, functionName, args };
  }

  const after = clone(next);
  const success = error === null;
  return {
    success,
    result,
    error,
    events,
    cpuInsnUsed: 1500 + Object.keys(args).length * 250 + (success ? 0 : 500),
    memBytesUsed: 1024 + JSON.stringify(after).length,
    readBytes: JSON.stringify(before).length,
    writeBytes: JSON.stringify(after).length,
    trace: traceTemplateStep(input.templateId ?? 'generic', functionName, before, after),
    stateBefore: before,
    stateAfter: after,
  };
}

function traceTemplateStep(
  contractId: string,
  functionName: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): unknown[] {
  return [
    { step: 1, hostFunction: 'load_contract', contractId },
    { step: 2, hostFunction: 'read_state', keys: Object.keys(before) },
    { step: 3, hostFunction: 'invoke_contract', functionName, args: after },
    { step: 4, hostFunction: 'write_state', diffKeys: diffKeys(before, after) },
  ];
}

function diffKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toDecimalString(
  value: string | number | Prisma.Decimal | undefined,
  fallback = '0',
): string {
  if (value === undefined) return fallback;
  return new Prisma.Decimal(value).toFixed();
}

function decimalPlus(left: string, right: string): string {
  return new Prisma.Decimal(left).plus(right).toFixed();
}

function decimalMinus(left: string, right: string): string {
  return new Prisma.Decimal(left).minus(right).toFixed();
}

function ensureNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
