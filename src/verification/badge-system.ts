import { type VulnerabilityReport } from './verifier';
import { type VerificationBadge } from './dsl';
import { logger } from '../logger';

export interface BadgeRecord {
  contractAddress: string;
  badge: VerificationBadge;
  reportId: string;
  safetyScore: number;
  vulnerabilitiesCount: number;
  issuedAt: string;
  expiresAt: string;
  metadata: Record<string, unknown>;
}

export interface BadgeConfig {
  ttlDays: number;
  minScoreForBadge: number;
  recheckIntervalMs: number;
  explorerEndpoint: string;
}

export class BadgeSystem {
  private badges: Map<string, BadgeRecord> = new Map();
  private config: BadgeConfig;

  constructor(config?: Partial<BadgeConfig>) {
    this.config = {
      ttlDays: config?.ttlDays ?? 90,
      minScoreForBadge: config?.minScoreForBadge ?? 50,
      recheckIntervalMs: config?.recheckIntervalMs ?? 86400000,
      explorerEndpoint: config?.explorerEndpoint ?? '/api/v1/contracts',
    };
  }

  issueBadge(contractAddress: string, report: VulnerabilityReport): BadgeRecord | null {
    if (!report.badge) {
      logger.info(`Contract ${contractAddress} does not qualify for a badge`);
      return null;
    }

    const existing = this.badges.get(contractAddress);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.ttlDays * 86400000);

    const record: BadgeRecord = {
      contractAddress,
      badge: report.badge,
      reportId: report.verifiedAt,
      safetyScore: report.summary.safetyScore,
      vulnerabilitiesCount: report.summary.vulnerabilities.length,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      metadata: {
        contractName: report.contractName,
        propertiesVerified: report.summary.verifiedProperties,
        propertiesTotal: report.summary.totalProperties,
        gasAnalysisPerformed: report.gasAnalysis !== null,
        reentrancyAnalysisPerformed: report.reentrancyAnalysis !== null,
        badgeLevel: report.badge.level,
      },
    };

    this.badges.set(contractAddress, record);

    logger.info(
      `Issued ${report.badge.level} badge for contract ${contractAddress} ` +
        `(score: ${report.summary.safetyScore}, vulns: ${report.summary.vulnerabilities.length})`,
    );

    return record;
  }

  revokeBadge(contractAddress: string): boolean {
    return this.badges.delete(contractAddress);
  }

  getBadge(contractAddress: string): BadgeRecord | undefined {
    const badge = this.badges.get(contractAddress);
    if (!badge) return undefined;

    if (new Date(badge.expiresAt) < new Date()) {
      this.badges.delete(contractAddress);
      return undefined;
    }

    return badge;
  }

  verifyBadgeValid(contractAddress: string): boolean {
    const badge = this.getBadge(contractAddress);
    if (!badge) return false;

    return badge.safetyScore >= this.config.minScoreForBadge;
  }

  async refreshBadge(
    contractAddress: string,
    newReport: VulnerabilityReport,
  ): Promise<BadgeRecord | null> {
    this.revokeBadge(contractAddress);
    return this.issueBadge(contractAddress, newReport);
  }

  getBadgeLevel(contractAddress: string): 'gold' | 'silver' | 'bronze' | null {
    const badge = this.getBadge(contractAddress);
    return badge?.badge.level ?? null;
  }

  getAllBadges(): BadgeRecord[] {
    const now = new Date();
    return Array.from(this.badges.values()).filter((b) => new Date(b.expiresAt) > now);
  }

  getBadgeCount(): { gold: number; silver: number; bronze: number } {
    const counts = { gold: 0, silver: 0, bronze: 0 };
    for (const badge of this.getAllBadges()) {
      counts[badge.badge.level]++;
    }
    return counts;
  }

  getBadgeForExplorer(contractAddress: string): {
    hasBadge: boolean;
    level: string | null;
    safetyScore: number | null;
    verifiedAt: string | null;
    explorerUrl: string | null;
  } | null {
    const badge = this.getBadge(contractAddress);
    if (!badge) {
      return {
        hasBadge: false,
        level: null,
        safetyScore: null,
        verifiedAt: null,
        explorerUrl: `${this.config.explorerEndpoint}/${contractAddress}`,
      };
    }

    return {
      hasBadge: true,
      level: badge.badge.level,
      safetyScore: badge.safetyScore,
      verifiedAt: badge.issuedAt,
      explorerUrl: `${this.config.explorerEndpoint}/${contractAddress}`,
    };
  }
}

export const globalBadgeSystem = new BadgeSystem();
