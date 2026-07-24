
export interface NlqTranslation {
  sql: string;
  apiEndpoint: string;
  filters: Record<string, unknown>;
  explanation: string;
  confidence: number;
  intent: string;
}

const KNOWN_FIELDS = new Set([
  'Transaction.id',
  'Transaction.hash',
  'Transaction.ledgerSequence',
  'Transaction.ledgerCloseTime',
  'Transaction.sourceAccount',
  'Transaction.contractAddress',
  'Transaction.functionName',
  'Transaction.functionArgs',
  'Transaction.status',
  'Transaction.feeCharged',
  'Transaction.humanReadable',
  'Transaction.failureReason',
  'Contract.id',
  'Contract.address',
  'Contract.name',
  'Contract.description',
  'Contract.abi',
  'Contract.functionSignatures',
  'Contract.isToken',
  'Contract.tokenSymbol',
  'Contract.tokenName',
  'Contract.tokenDecimals',
  'Contract.wasmHash',
  'Contract.isVerified',
  'Event.id',
  'Event.transactionHash',
  'Event.contractAddress',
  'Event.eventType',
  'Event.topicSymbol',
  'Event.topics',
  'Event.data',
  'Event.decoded',
  'Event.ledgerSequence',
  'Event.ledgerCloseTime',
  'Ledger.sequence',
  'Ledger.hash',
  'Ledger.closeTime',
  'Ledger.txCount',
  'StellarAccount.id',
  'StellarAccount.address',
  'StellarAccount.xlmBalance',
]);

const INTENT_TO_MODEL: Record<string, string> = {
  list_transactions: 'Transaction',
  lookup_contract: 'Contract',
  aggregation_volume: 'Transaction',
  time_series: 'Event',
  comparison: 'Contract',
  distribution: 'Event',
  alert_condition: 'Transaction',
  lookup_address: 'StellarAccount',
  general_query: 'Transaction',
};

interface FilterMapping {
  field: string;
  prismaField: string;
  type: 'string' | 'number' | 'date' | 'boolean';
  operator: 'equals' | 'contains' | 'gte' | 'lte' | 'gt' | 'lt';
}

const FILTER_MAPPINGS: FilterMapping[] = [
  { field: 'sender', prismaField: 'sourceAccount', type: 'string', operator: 'equals' },
  { field: 'receiver', prismaField: 'sourceAccount', type: 'string', operator: 'equals' },
  { field: 'contract', prismaField: 'contractAddress', type: 'string', operator: 'equals' },
  { field: 'minAmount', prismaField: 'feeCharged', type: 'number', operator: 'gte' },
  { field: 'maxAmount', prismaField: 'feeCharged', type: 'number', operator: 'lte' },
  { field: 'dateFrom', prismaField: 'ledgerCloseTime', type: 'date', operator: 'gte' },
  { field: 'dateTo', prismaField: 'ledgerCloseTime', type: 'date', operator: 'lte' },
  { field: 'status', prismaField: 'status', type: 'string', operator: 'equals' },
  { field: 'eventType', prismaField: 'eventType', type: 'string', operator: 'equals' },
  { field: 'name', prismaField: 'name', type: 'string', operator: 'contains' },
  { field: 'isToken', prismaField: 'isToken', type: 'boolean', operator: 'equals' },
  { field: 'isVerified', prismaField: 'isVerified', type: 'boolean', operator: 'equals' },
];

const INTENT_TO_ENDPOINT: Record<string, string> = {
  list_transactions: '/api/v1/transactions',
  lookup_contract: '/api/v1/contracts',
  aggregation_volume: '/api/v1/analytics/gas',
  time_series: '/api/v1/events',
  comparison: '/api/v1/analytics',
  distribution: '/api/v1/events',
  alert_condition: '/api/v1/alerts',
  lookup_address: '/api/v1/wallets',
  general_query: '/api/v1/search/transactions',
};

export function validateQuery(sql: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const lower = sql.toLowerCase();

  const forbidden = [
    'drop',
    'truncate',
    'delete',
    'insert',
    'update',
    'alter',
    'create',
    'grant',
    'revoke',
  ];
  for (const keyword of forbidden) {
    if (lower.includes(keyword)) {
      errors.push(`Forbidden SQL keyword: ${keyword}`);
    }
  }

  const fieldRefs = sql.match(/\b[A-Z]\w+\.\w+\b/g) || [];
  for (const ref of fieldRefs) {
    if (!KNOWN_FIELDS.has(ref) && !ref.startsWith('_')) {
      errors.push(`Unknown field reference: ${ref}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function generateExplanation(
  intent: string,
  filters: Record<string, unknown>,
  sql: string,
  model: string,
): string {
  const parts: string[] = [];

  const intentLabels: Record<string, string> = {
    list_transactions: 'listing transactions',
    lookup_contract: 'finding contracts',
    aggregation_volume: 'aggregating volumes',
    time_series: 'showing time-series data',
    comparison: 'comparing protocols',
    distribution: 'showing distribution',
    alert_condition: 'setting up alert conditions',
    lookup_address: 'looking up addresses',
    general_query: 'searching blockchain data',
  };

  parts.push(`This query will execute by ${intentLabels[intent] || 'searching'}`);

  const filterLabels: Record<string, string> = {
    sender: 'sender address',
    receiver: 'receiver address',
    contract: 'contract address',
    minAmount: 'minimum amount',
    maxAmount: 'maximum amount',
    dateFrom: 'start date',
    dateTo: 'end date',
    status: 'transaction status',
    eventType: 'event type',
    name: 'contract name',
    isToken: 'token filter',
    isVerified: 'verification status',
    timeRange: 'time range',
    limit: 'maximum results',
  };

  const activeFilters = Object.entries(filters)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      const label = filterLabels[k] || k;
      const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `${label} = ${val}`;
    });

  if (activeFilters.length > 0) {
    parts.push(`with filters: ${activeFilters.join(', ')}`);
  }

  parts.push(`on the ${model} table`);

  return parts.join('. ') + '.';
}

export async function translateNlToQuery(
  query: string,
  intent: string,
  filters: Record<string, unknown>,
  _language: string,
): Promise<NlqTranslation> {
  const model = INTENT_TO_MODEL[intent] || 'Transaction';
  const apiEndpoint = INTENT_TO_ENDPOINT[intent] || '/api/v1/search/transactions';

  const sql = buildSqlFromFilters(model, intent, filters);

  const validation = validateQuery(sql);
  const explanation = generateExplanation(intent, filters, sql, model);

  return {
    sql: validation.valid ? sql : `-- Validation warnings: ${validation.errors.join('; ')}\n${sql}`,
    apiEndpoint,
    filters,
    explanation,
    confidence: validation.valid ? 0.85 : 0.5,
    intent,
  };
}

function buildSqlFromFilters(
  model: string,
  intent: string,
  filters: Record<string, unknown>,
): string {
  const whereClauses: string[] = [];

  for (const mapping of FILTER_MAPPINGS) {
    const val = filters[mapping.field];
    if (val === undefined || val === null) continue;

    const field = `${model}.${mapping.prismaField}`;
    let clause: string;

    switch (mapping.operator) {
      case 'equals':
        clause = `${field} = '${String(val).replace(/'/g, "''")}'`;
        break;
      case 'contains':
        clause = `${field} ILIKE '%${String(val).replace(/'/g, "''")}%'`;
        break;
      case 'gte':
        clause = `${field} >= '${String(val)}'`;
        break;
      case 'lte':
        clause = `${field} <= '${String(val)}'`;
        break;
      default:
        clause = `${field} = '${String(val)}'`;
    }

    whereClauses.push(clause);
  }

  const limit = (filters.limit as number) || 50;
  const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const orderBy =
    intent === 'time_series' ? 'ORDER BY ledgerCloseTime ASC' : 'ORDER BY ledgerCloseTime DESC';

  return `SELECT * FROM "${model}" ${where} ${orderBy} LIMIT ${limit}`;
}

export function mergeContext(
  existingFilters: Record<string, unknown>,
  newFilters: Record<string, unknown>,
): Record<string, unknown> {
  return { ...existingFilters, ...newFilters };
}

export function extractEntities(query: string): {
  addresses: string[];
  numbers: number[];
  dates: Date[];
} {
  const addresses = (query.match(/G[A-Z0-9]{55}/g) || []).slice(0, 5);
  const numbers = (query.match(/\b\d+\b/g) || []).map(Number).filter((n) => n > 0);
  const dates: Date[] = [];

  const dateMatch = query.match(/\b(\d{4}-\d{2}-\d{2})\b/g);
  if (dateMatch) {
    for (const d of dateMatch) {
      const parsed = new Date(d);
      if (!isNaN(parsed.getTime())) dates.push(parsed);
    }
  }

  return { addresses, numbers, dates };
}

export function extractTimeRange(query: string): { value: number; unit: string } | null {
  const match = query.match(/\b(last|past)\s+(\d+)\s+(hour|day|week|month)\b/i);
  if (match) {
    return { value: parseInt(match[2], 10), unit: match[3].toLowerCase() };
  }
  return null;
}

export function extractTokenSymbol(query: string): string | null {
  const match = query.match(/\b(\w+)\s*(token|swap|transfer|balance)\b/i);
  return match ? match[1].toUpperCase() : null;
}

export function extractContractPattern(query: string): string | null {
  const match = query.match(/looks?\s+like\s+['"]?(\w+)['"]?/i);
  return match ? match[1] : null;
}
