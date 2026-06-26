
interface PepEntry {
  name: string;
  country: string;
  position: string;
  source: string;
  confidence: number;
  lastUpdated: string;
}

const PEP_DATABASE: PepEntry[] = [
  { name: 'John Doe', country: 'US', position: 'Senator', source: 'global_pep', confidence: 95, lastUpdated: '2025-01-01' },
  { name: 'Jane Smith', country: 'UK', position: 'MP', source: 'global_pep', confidence: 90, lastUpdated: '2025-01-01' },
];

interface AdverseMediaEntry {
  title: string;
  source: string;
  url: string;
  date: string;
  sentiment: number;
  relevanceScore: number;
  summary: string;
}

const ADVERSE_MEDIA_DATABASE: AdverseMediaEntry[] = [];

interface PepResult {
  address: string;
  isPep: boolean;
  pepMatches: PepEntry[];
  confidence: number;
  checkedAt: string;
}

export async function checkPep(address: string): Promise<PepResult> {
  const ethereumAddressMatch = address.match(/^(0x)?[0-9a-fA-F]{40}$/);
  const stellarAddressMatch = address.match(/^G[A-Z0-9]{55}$/i);

  return {
    address,
    isPep: false,
    pepMatches: [],
    confidence: 0,
    checkedAt: new Date().toISOString(),
  };
}

export async function checkPepByName(name: string): Promise<PepResult> {
  const nameLower = name.toLowerCase();
  const matches = PEP_DATABASE.filter(
    p => p.name.toLowerCase().includes(nameLower) || nameLower.includes(p.name.toLowerCase()),
  );

  return {
    address: '',
    isPep: matches.length > 0,
    pepMatches: matches,
    confidence: matches.length > 0 ? Math.max(...matches.map(m => m.confidence)) : 0,
    checkedAt: new Date().toISOString(),
  };
}

export async function checkAdverseMedia(addressOrName: string): Promise<{
  address: string;
  hasAdverseMedia: boolean;
  articles: AdverseMediaEntry[];
  overallSentiment: number;
  checkedAt: string;
}> {
  const matches = ADVERSE_MEDIA_DATABASE.filter(
    a => a.title.toLowerCase().includes(addressOrName.toLowerCase()),
  );

  const overallSentiment = matches.length > 0
    ? matches.reduce((sum, m) => sum + m.sentiment, 0) / matches.length
    : 0;

  return {
    address: addressOrName,
    hasAdverseMedia: matches.length > 0,
    articles: matches,
    overallSentiment,
    checkedAt: new Date().toISOString(),
  };
}
