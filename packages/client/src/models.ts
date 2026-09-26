/** Response models for the reputation API. */
export interface ReputationScore {
  address: string;
  score: number;
  [key: string]: unknown;
}

export interface LeaderboardEntry {
  address: string;
  score: number;
  rank?: number;
}

export interface Leaderboard {
  category?: string;
  entries: LeaderboardEntry[];
}

export interface Badge {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface BadgeList {
  address?: string;
  badges: Badge[];
}

export interface TrustPath {
  from: string;
  to: string;
  path: string[];
  [key: string]: unknown;
}

export type OracleAttestation = Record<string, unknown>;
