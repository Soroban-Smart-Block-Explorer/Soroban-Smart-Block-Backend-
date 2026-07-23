export type ProtocolCategory =
  | 'dex'
  | 'lending'
  | 'nft'
  | 'token'
  | 'staking'
  | 'governance'
  | 'oracle'
  | 'vesting'
  | 'liquidity'
  | 'bridge'
  | 'multisig'
  | 'registry'
  | 'unknown';

export type Confidence = 'high' | 'medium' | 'low';

export type DetectedProtocol = 'SEP-41' | 'DEX' | 'Lending' | 'NFT' | 'Staking' | 'Governance' | 'Oracle';

export interface ClassificationResult {
  category: ProtocolCategory;
  confidence: Confidence;
  description: string;
  protocols: DetectedProtocol[];
  matchedPatterns: string[];
}

interface CategoryPattern {
  category: ProtocolCategory;
  patterns: RegExp[];
  requiredMatches: number;
  protocols: DetectedProtocol[];
  description: string;
}

const CATEGORY_PATTERNS: CategoryPattern[] = [
  {
    category: 'token',
    patterns: [/^transfer$/, /^balance$/, /^approve$/, /^allowance$/, /^mint$/, /^burn$/, /^decimals$/, /^symbol$/, /^name$/, /^total_supply$/],
    requiredMatches: 3,
    protocols: ['SEP-41'],
    description: 'Fungible token contract implementing SEP-41 standard',
  },
  {
    category: 'dex',
    patterns: [/swap/, /exchange/, /trade/, /^get_price$/, /^add_liquidity$/, /^remove_liquidity$/, /^get_reserves$/, /^pool/, /quote/, /route/],
    requiredMatches: 2,
    protocols: ['DEX', 'SEP-41'],
    description: 'Decentralized exchange or automated market maker',
  },
  {
    category: 'lending',
    patterns: [/^borrow$/, /^repay$/, /^deposit$/, /^withdraw$/, /^liquidate/, /^collateral/, /^interest/, /^supply$/, /^redeem$/, /health_factor/],
    requiredMatches: 2,
    protocols: ['Lending'],
    description: 'Lending and borrowing protocol',
  },
  {
    category: 'nft',
    patterns: [/^mint$/, /^transfer$/, /^owner_of$/, /^token_uri$/, /^get_token$/, /^approve$/, /^set_approval/, /^token_id/, /collection/, /metadata/],
    requiredMatches: 2,
    protocols: ['NFT'],
    description: 'Non-fungible token contract',
  },
  {
    category: 'staking',
    patterns: [/^stake$/, /^unstake$/, /^claim$/, /^reward/, /^epoch/, /^delegate$/, /^undelegate$/, /^validator/, /^bonding/, /^unbonding/],
    requiredMatches: 2,
    protocols: ['Staking'],
    description: 'Staking and rewards distribution contract',
  },
  {
    category: 'governance',
    patterns: [/^propose$/, /^vote$/, /^execute$/, /^cancel$/, /^delegate$/, /^proposal/, /^quorum/, /^timelock/, /^veto/, /^snapshot/],
    requiredMatches: 2,
    protocols: ['Governance'],
    description: 'On-chain governance and voting contract',
  },
  {
    category: 'oracle',
    patterns: [/^get_price$/, /^set_price$/, /^update_price$/, /^feed/, /^oracle/, /^price_feed/, /^submit/, /aggregat/, /^twap/, /^report/],
    requiredMatches: 2,
    protocols: ['Oracle'],
    description: 'Price oracle or data feed contract',
  },
  {
    category: 'vesting',
    patterns: [/^vest$/, /^claim$/, /^release$/, /^schedule/, /^cliff/, /^linear/, /^beneficiary/, /^vesting/, /lock/, /^unlock/],
    requiredMatches: 2,
    protocols: [],
    description: 'Token vesting and lock-up contract',
  },
  {
    category: 'liquidity',
    patterns: [/^add_liquidity$/, /^remove_liquidity$/, /^deposit$/, /^withdraw$/, /^lp_token/, /^get_shares/, /^pool_share/, /yield/, /farm/, /harvest/],
    requiredMatches: 2,
    protocols: ['DEX'],
    description: 'Liquidity provision and yield farming contract',
  },
  {
    category: 'bridge',
    patterns: [/^lock$/, /^unlock$/, /^bridge$/, /^relay/, /^verify/, /^proof/, /^cross_chain/, /^mint$/, /^burn$/, /^redeem/],
    requiredMatches: 2,
    protocols: [],
    description: 'Cross-chain bridge contract',
  },
  {
    category: 'multisig',
    patterns: [/^submit$/, /^confirm$/, /^revoke$/, /^execute$/, /^owners$/, /^required$/, /^add_owner$/, /^remove_owner$/, /threshold/, /^quorum/],
    requiredMatches: 3,
    protocols: [],
    description: 'Multi-signature wallet contract',
  },
  {
    category: 'registry',
    patterns: [/^register$/, /^resolve$/, /^lookup$/, /^set$/, /^get$/, /^list$/, /^remove$/, /^update$/, /record/, /entry/],
    requiredMatches: 3,
    protocols: [],
    description: 'Registry or directory contract',
  },
];

const ANOMALOUS_PATTERNS: RegExp[] = [
  /selfdestruct/, /suicide/, /backdoor/, /drain/, /steal/, /rug/, /honeypot/, /hidden/,
];

const ADMIN_PATTERNS: RegExp[] = [
  /^admin$/, /^owner$/, /^set_admin/, /^upgrade$/, /^pause$/, /^unpause$/, /^emergency/,
];

export function classifyContract(functionNames: string[]): ClassificationResult {
  const lower = functionNames.map((f) => f.toLowerCase());
  const scores: { result: CategoryPattern; score: number; matched: string[] }[] = [];

  for (const pattern of CATEGORY_PATTERNS) {
    const matched: string[] = [];
    for (const fn of lower) {
      for (const re of pattern.patterns) {
        if (re.test(fn) && !matched.includes(fn)) {
          matched.push(fn);
          break;
        }
      }
    }
    if (matched.length >= pattern.requiredMatches) {
      scores.push({ result: pattern, score: matched.length, matched });
    }
  }

  if (scores.length === 0) {
    return {
      category: 'unknown',
      confidence: 'low',
      description: 'Contract purpose could not be determined from function signatures',
      protocols: [],
      matchedPatterns: [],
    };
  }

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const ratio = best.score / best.result.patterns.length;

  const confidence: Confidence = ratio >= 0.5 ? 'high' : ratio >= 0.25 ? 'medium' : 'low';

  return {
    category: best.result.category,
    confidence,
    description: best.result.description,
    protocols: best.result.protocols,
    matchedPatterns: best.matched,
  };
}

export function detectAnomalousPatterns(functionNames: string[]): string[] {
  const lower = functionNames.map((f) => f.toLowerCase());
  const flags: string[] = [];
  for (const fn of lower) {
    for (const re of ANOMALOUS_PATTERNS) {
      if (re.test(fn)) {
        flags.push(`Suspicious function name detected: "${fn}"`);
      }
    }
  }
  return flags;
}

export function detectAdminFunctions(functionNames: string[]): string[] {
  const lower = functionNames.map((f) => f.toLowerCase());
  return lower.filter((fn) => ADMIN_PATTERNS.some((re) => re.test(fn)));
}
