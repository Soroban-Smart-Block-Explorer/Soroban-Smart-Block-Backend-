import { formatAmount } from './args-decoder';

export interface RenderContext {
  /** Decoded values: plain strings, numbers, bigints, or DecodedArg objects */
  args: Record<string, unknown>;
  /** Token symbol to append to amounts, e.g. "USDC" */
  tokenSymbol?: string;
  /** Decimal places for bigint amounts (default 7) */
  decimals?: number;
  /** Contract / protocol name appended at the end when present */
  contractName?: string;
}

/**
 * Built-in templates for standard SEP-41 events and common DEX operations.
 * Keyed by function/event name.
 */
export const BUILT_IN_TEMPLATES: Record<string, string> = {
  transfer: 'Address {from} transferred {amount} {token} to {to}',
  transfer_from: '{spender} transferred {amount} {token} from {from} to {to}',
  mint: 'Minted {amount} {token} to {to}',
  burn: '{from} burned {amount} {token}',
  approve: '{from} approved {spender} to spend {amount} {token}',
  swap: '{from} swapped {amount_in} {token} → {amount_out}',
  add_liquidity: '{from} added liquidity: {amount_a} + {amount_b}',
  remove_liquidity: '{from} removed liquidity: {amount_a} + {amount_b}',
};

/**
 * Resolve a single value to its display string.
 * Handles DecodedArg objects, bigints, and primitives.
 */
function resolve(val: unknown, decimals = 7): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object' && 'formatted' in (val as object)) {
    return (val as { formatted: string }).formatted;
  }
  if (typeof val === 'bigint') return formatAmount(val, decimals);
  return String(val);
}

/**
 * Interpolate a template string with values from ctx.
 *
 * Placeholders:
 *   {key}          — replaced with resolved value
 *   {key|truncate} — address truncated to first 6 + last 4 chars
 *   {token}        — special: uses ctx.tokenSymbol or empty string
 *
 * @example
 * renderTemplate(
 *   'Address {from} transferred {amount} {token} to {to}',
 *   { args: { from: 'GABC...', to: 'GXYZ...', amount: 100n }, tokenSymbol: 'USDC', decimals: 7 }
 * )
 * // → "Address GABC... transferred 0.0000100 USDC to GXYZ..."
 */
export function renderTemplate(template: string, ctx: RenderContext): string {
  const { args, tokenSymbol = '', decimals = 7, contractName } = ctx;

  let text = template.replace(
    /\{(\w+)(?:\|(\w+))?\}/g,
    (_match, key: string, modifier?: string) => {
      if (key === 'token') return tokenSymbol;

      const val = args[key];
      const display = resolve(val, decimals);

      if (modifier === 'truncate' && display.length > 12) {
        return `${display.slice(0, 6)}…${display.slice(-4)}`;
      }
      return display;
    },
  );

  if (contractName) text += ` on ${contractName}`;
  return text;
}

/**
 * Render using a built-in template by function/event name, falling back to a
 * generic description if no template is registered.
 */
export function renderBuiltIn(fnName: string, ctx: RenderContext): string {
  const template = BUILT_IN_TEMPLATES[fnName];
  if (!template) {
    return `Called ${fnName}${ctx.contractName ? ` on ${ctx.contractName}` : ''}`;
  }
  return renderTemplate(template, ctx);
}
