/**
 * Admin Service — encapsulates business logic for administrative operations,
 * including ledger hash chain consistency checks.
 */

import { LedgerRepository, ledgerRepository } from '../repositories/ledger.repository';

export interface LedgerInconsistency {
  sequence: number;
  expectedPreviousHash: string;
  actualPreviousHash: string;
  message: string;
}

export interface ConsistencyCheckReport {
  success: boolean;
  scannedCount: number;
  inconsistenciesCount: number;
  inconsistencies: LedgerInconsistency[];
}

export class AdminService {
  constructor(private readonly repo: LedgerRepository = ledgerRepository) {}

  async runConsistencyCheck(limit: number = 100): Promise<ConsistencyCheckReport> {
    const ledgers = await this.repo.findRecentLedgers(limit);
    const inconsistencies: LedgerInconsistency[] = [];

    // Scan ledgers and verify hash chain continuity
    for (let i = 0; i < ledgers.length - 1; i++) {
      const current = ledgers[i];
      const previous = ledgers[i + 1]; // ordered desc, index i+1 is sequence - 1

      if (current.sequence - 1 !== previous.sequence) {
        inconsistencies.push({
          sequence: current.sequence,
          expectedPreviousHash: '',
          actualPreviousHash: '',
          message: `Gap detected between ledger ${current.sequence} and ${previous.sequence}`,
        });
        continue;
      }

      if (current.previousLedgerHash && current.previousLedgerHash !== previous.hash) {
        inconsistencies.push({
          sequence: current.sequence,
          expectedPreviousHash: previous.hash,
          actualPreviousHash: current.previousLedgerHash,
          message: `Hash mismatch at ledger ${current.sequence}: previous hash in DB is ${previous.hash}, but current previousLedgerHash is ${current.previousLedgerHash}`,
        });
      }
    }

    return {
      success: inconsistencies.length === 0,
      scannedCount: ledgers.length,
      inconsistenciesCount: inconsistencies.length,
      inconsistencies,
    };
  }
}

export const adminService = new AdminService();
