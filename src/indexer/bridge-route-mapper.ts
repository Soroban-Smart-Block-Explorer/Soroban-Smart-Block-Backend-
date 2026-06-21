import { prismaRead as prisma } from '../db';

export interface BridgeRoute {
  transactionHash: string;
  direction: 'inbound' | 'outbound';
  sourceChain: string;
  destinationChain: string;
  tokenAddress: string;
  tokenSymbol?: string;
  amount: string;
  senderAddress: string;
  recipientAddress: string;
  lockAction?: string;
  unlockAction?: string;
  externalScannerUrl?: string;
  bridgeStandard: 'near_intents' | 'mastercard_crypto' | 'generic';
}

const BRIDGE_PATTERNS = {
  lock: /lock|deposit|bridge_in/i,
  unlock: /unlock|withdraw|bridge_out/i,
  mint: /mint|wrap/i,
  burn: /burn|unwrap/i,
};

const EXTERNAL_SCANNERS: Record<string, string> = {
  ethereum: 'https://etherscan.io/tx/',
  solana: 'https://solscan.io/tx/',
  polygon: 'https://polygonscan.com/tx/',
  arbitrum: 'https://arbiscan.io/tx/',
  optimism: 'https://optimistic.etherscan.io/tx/',
  near: 'https://explorer.near.org/transactions/',
  avalanche: 'https://snowtrace.io/tx/',
};

/**
 * Analyze transaction for cross-chain bridge actions.
 * Tracks token lock/unlock and extracts recipient addresses.
 */
export async function analyzeBridgeRoute(transactionHash: string): Promise<BridgeRoute | null> {
  const transaction = await prisma.transaction.findUnique({
    where: { hash: transactionHash },
    include: { events: true, contract: true },
  });

  if (!transaction) return null;

  const functionName = transaction.functionName?.toLowerCase() || '';
  const events = transaction.events || [];

  // Detect bridge direction
  let direction: 'inbound' | 'outbound' = 'outbound';
  let lockAction: string | undefined;
  let unlockAction: string | undefined;

  if (BRIDGE_PATTERNS.lock.test(functionName)) {
    direction = 'outbound';
    lockAction = transaction.functionName ?? undefined;
  } else if (BRIDGE_PATTERNS.unlock.test(functionName)) {
    direction = 'inbound';
    unlockAction = transaction.functionName ?? undefined;
  }

  // Extract token and recipient info from events
  let tokenAddress = '';
  let tokenSymbol = '';
  let amount = '0';
  let recipientAddress = '';

  for (const event of events) {
    const decoded = event.decoded as any;
    const topicSymbol = event.topicSymbol?.toLowerCase() || '';

    if (topicSymbol.includes('transfer')) {
      tokenAddress = event.contractAddress;
      tokenSymbol = decoded?.symbol || '';
      amount = decoded?.amount || decoded?.value || '0';
      recipientAddress = decoded?.to || decoded?.recipient || '';
    }
  }

  // Detect bridge standard
  const bridgeStandard = detectBridgeStandard(transaction.contractAddress || '', functionName);

  // Generate external scanner URL
  const externalScannerUrl = generateScannerUrl(direction, recipientAddress, bridgeStandard);

  return {
    transactionHash,
    direction,
    sourceChain: 'soroban',
    destinationChain: inferDestinationChain(bridgeStandard, recipientAddress),
    tokenAddress,
    tokenSymbol,
    amount,
    senderAddress: transaction.sourceAccount,
    recipientAddress,
    lockAction,
    unlockAction,
    externalScannerUrl,
    bridgeStandard,
  };
}

function detectBridgeStandard(
  contractAddress: string,
  functionName: string,
): 'near_intents' | 'mastercard_crypto' | 'generic' {
  if (contractAddress.includes('near') || functionName.includes('near')) {
    return 'near_intents';
  }
  if (contractAddress.includes('mastercard') || functionName.includes('mastercard')) {
    return 'mastercard_crypto';
  }
  return 'generic';
}

function inferDestinationChain(standard: string, recipientAddress: string): string {
  if (standard === 'near_intents') return 'near';
  if (standard === 'mastercard_crypto') return 'mastercard_network';

  // Infer from recipient address format
  if (recipientAddress.startsWith('0x')) return 'ethereum';
  if (recipientAddress.length === 44 && recipientAddress.endsWith('=')) return 'solana';
  if (recipientAddress.includes('.near')) return 'near';

  return 'unknown';
}

function generateScannerUrl(
  direction: string,
  recipientAddress: string,
  standard: string,
): string | undefined {
  const chain = inferDestinationChain(standard, recipientAddress);
  const baseUrl = EXTERNAL_SCANNERS[chain];

  if (!baseUrl) return undefined;

  // For Solana, use address lookup; for others, use tx hash
  if (chain === 'solana') {
    return `${baseUrl}${recipientAddress}`;
  }

  return baseUrl;
}

/**
 * Store bridge route metadata in transaction.
 */
export async function storeBridgeRoute(transactionHash: string, route: BridgeRoute): Promise<void> {
  const existing = await prisma.transaction.findUnique({
    where: { hash: transactionHash },
    select: { functionArgs: true },
  });

  const existingArgs = existing?.functionArgs;
  const baseArgs = typeof existingArgs === 'object' && existingArgs !== null ? existingArgs : {};

  await prisma.transaction.update({
    where: { hash: transactionHash },
    data: {
      functionArgs: {
        ...baseArgs,
        _bridgeRoute: {
          direction: route.direction,
          sourceChain: route.sourceChain,
          destinationChain: route.destinationChain,
          tokenAddress: route.tokenAddress,
          recipientAddress: route.recipientAddress,
          externalScannerUrl: route.externalScannerUrl,
          bridgeStandard: route.bridgeStandard,
        },
      },
    },
  });
}

/**
 * Query bridge routes by direction and chain.
 */
export async function queryBridgeRoutes(
  direction: 'inbound' | 'outbound',
  destinationChain?: string,
): Promise<BridgeRoute[]> {
  const transactions = await prisma.transaction.findMany({
    where: {
      functionName: {
        in:
          direction === 'outbound'
            ? ['lock', 'deposit', 'bridge_in']
            : ['unlock', 'withdraw', 'bridge_out'],
      },
    },
    include: { events: true },
    take: 100,
  });

  const routes: BridgeRoute[] = [];

  for (const tx of transactions) {
    const route = await analyzeBridgeRoute(tx.hash);
    if (route && (!destinationChain || route.destinationChain === destinationChain)) {
      routes.push(route);
    }
  }

  return routes;
}
