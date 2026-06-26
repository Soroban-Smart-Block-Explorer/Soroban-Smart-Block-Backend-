export type ChainId = string;
export type Address = string;

export interface AttestationInput {
  chainId: ChainId;
  schemaId: string;
  attester: Address;
  subject: Address;
  recipient?: Address;
  issuedAt?: string;
  expiresAt?: string;
  revoked?: boolean;
  signature?: string;
  transactionHash?: string;
  blockNumber?: number | string;
  data?: Record<string, unknown>;
}

export interface OnChainAttestation extends AttestationInput {
  uid: string;
  verified: boolean;
  verificationMessage: string;
}

export interface VerifiableCredential {
  '@context': string[] | string;
  id: string;
  type: string[] | string;
  issuer: string | { id: string };
  issuanceDate: string;
  expirationDate?: string;
  credentialSubject: {
    id: string;
    [key: string]: unknown;
  };
  proof: {
    type: string;
    created: string;
    verificationMethod: string;
    proofPurpose: string;
    proofValue: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface TrustEdgeInput {
  chainId: ChainId;
  from: Address;
  to: Address;
  weight?: number | string;
  type?: string;
  timestamp?: string;
  transactionHash?: string;
}

export interface EndorsementInput {
  chainId: ChainId;
  endorser: Address;
  subject: Address;
  weight?: number | string;
  timestamp?: string;
  transactionHash?: string;
}

export interface LinkedIdentityInput {
  chainId: ChainId;
  address: Address;
  message: string;
  signature: string;
}

export interface ChainReputationData {
  chainId: ChainId;
  address: Address;
  nativeBalance?: string | number;
  transactionCount?: number | string;
  successfulTransactionCount?: number | string;
  failedTransactionCount?: number | string;
  uniqueContractsInteracted?: number | string;
  governanceVotes?: number | string;
  governanceWins?: number | string;
  firstSeen?: string;
  lastSeen?: string;
  attestations?: AttestationInput[];
  verifiableCredentials?: VerifiableCredential[];
  trustEdges?: TrustEdgeInput[];
  endorsements?: EndorsementInput[];
  sybilCluster?: string;
  sybilRisk?: number | string;
}

export interface ReputationBreakdownItem {
  signal: string;
  category: string;
  points: number;
  maxPoints: number;
  evidence: string;
}

export interface ChainScore {
  chainId: ChainId;
  address: Address;
  score: number;
  breakdown: ReputationBreakdownItem[];
}

export interface ScoreResult {
  address: Address;
  score: number;
  rankCategory: string;
  activeChains: ChainId[];
  linkedAddresses: Address[];
  chainScores: ChainScore[];
  breakdown: ReputationBreakdownItem[];
  badges: Badge[];
  sybil: SybilAssessment;
  proof: ReputationProof;
}

export interface LeaderboardEntry {
  rank: number;
  address: Address;
  score: number;
  activeChains: number;
  linkedAddresses: string[];
  badges: string[];
  sybilRisk: number;
}

export interface BadgeDefinition {
  id: string;
  name: string;
  description: string;
  criteria: string;
  verifiable: boolean;
}

export interface Badge {
  id: string;
  name: string;
  description: string;
  criteria: string;
  earnedAt?: string;
  verifiable: boolean;
}

export interface SybilAssessment {
  address: Address;
  isSuspicious: boolean;
  risk: number;
  confidence: number;
  reasons: string[];
  cluster?: string;
}

export interface IdentityLinkRequest {
  canonicalAddress: Address;
  links: LinkedIdentityInput[];
}

export interface VerifiedIdentityLink {
  chainId: ChainId;
  address: Address;
  canonicalAddress: Address;
  verified: boolean;
  messageHash: string;
}

export interface TrustGraph {
  nodes: Address[];
  edges: Array<{
    from: Address;
    to: Address;
    chainId: ChainId;
    weight: number;
    type?: string;
    transactionHash?: string;
  }>;
}

export interface TrustPath {
  from: Address;
  to: Address;
  path: Address[];
  distance: number;
  chainIds: ChainId[];
}

export interface ArbitrationCase {
  id: string;
  challenger: Address;
  respondent: Address;
  challenge: string;
  evidenceHash: string;
  quorumVotes: number;
  status: 'open' | 'resolved';
  outcome?: 'upheld' | 'rejected' | 'timeout';
  createdAt: string;
  resolvedAt?: string;
}

export interface ArbitrationVote {
  caseId: string;
  voter: Address;
  vote: 'uphold' | 'reject' | 'abstain';
  weight: number;
  signature?: string;
  transactionHash?: string;
}

export interface ArbitrationResult {
  caseId: string;
  status: 'open' | 'resolved';
  outcome?: 'upheld' | 'rejected' | 'timeout';
  votesFor: number;
  votesAgainst: number;
  votesAbstain: number;
  quorumVotes: number;
  quorumReached: boolean;
  winner: string;
}

export interface ReputationProof {
  algorithmVersion: string;
  address: Address;
  linkedAddresses: Address[];
  chainIds: ChainId[];
  score: number;
  inputHash: string;
  breakdownHash: string;
  badgeHash: string;
}

export interface OracleReputationResponse {
  address: Address;
  score: number;
  breakdown: ReputationBreakdownItem[];
  badges: Badge[];
  attestations: OnChainAttestation[];
  credentials: VerifiableCredential[];
  sybil: SybilAssessment;
  proof: ReputationProof;
}

export interface SignatureVerifier {
  verify(chainId: ChainId, address: Address, message: string, signature: string): boolean;
}
