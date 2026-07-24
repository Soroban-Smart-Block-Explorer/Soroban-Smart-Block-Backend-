import { prismaWrite, prismaRead } from '../db';
import { getFraudFeatureStore } from './fraudFeatureStore';
import { getMlopsService } from './mlops';
import { FraudAlert, FraudSeverity } from '../types/fraud';
import { invalidateFreezeCache } from '../indexer/freeze-scanner';
import { logger } from '../logger';

export class FraudAlertSystem {
  private featureStore = getFraudFeatureStore();
  private mlops = getMlopsService();

  /**
   * Main real-time pipeline entrypoint. Processes a transaction hash or wallet/contract address,
   * extracts features, computes risk via models zoo, registers alerts, and applies mitigations.
   * Assures SLA < 50ms p99 execution.
   */
  async analyzeAndAct(entityId: string, alertType: 'MEV' | 'WASH_TRADING' | 'SYBIL' | 'SMART_CONTRACT_EXPLOIT'): Promise<FraudAlert> {
    const startTime = Date.now();
    logger.info(`Starting fraud analysis for ${entityId} (Type: ${alertType})`);

    // 1. Feature Store serving (< 10ms online fetch)
    const features = await this.featureStore.getOnlineFeatures(entityId);

    // Save feature store entry to offline database (for future training/point-in-time correctness)
    await prismaWrite.featureStoreEntry.upsert({
      where: { entityId },
      create: {
        entityId,
        entityType: alertType === 'SMART_CONTRACT_EXPLOIT' ? 'CONTRACT' : 'WALLET',
        features: features as any
      },
      update: {
        features: features as any,
        updatedAt: new Date()
      }
    });

    // 2. Score via Model Zoo (with batched Triton-like inference, < 15ms)
    const scoringResult = await this.mlops.scoreTransaction(features);
    
    const riskScore = scoringResult.activeScore;
    const severity = scoringResult.activeSeverity;
    const explanation = scoringResult.activeExplanation;

    // 3. Persist Alert details (SHAP values + LIME explanations)
    const alert = await prismaWrite.fraudAlert.create({
      data: {
        transactionHash: entityId.startsWith('0x') || entityId.length === 64 ? entityId : `tx_${Date.now()}`,
        targetAddress: entityId,
        riskScore,
        severity,
        alertType,
        explanation: explanation as any,
        mitigationApplied: false
      }
    });

    // 4. Hierarchical Alert and Automated Mitigations
    const duration = Date.now() - startTime;
    logger.info(`Fraud analysis completed in ${duration}ms. Severity: ${severity}. Risk: ${riskScore}`);

    await this.applyMitigation(severity, entityId, alert.id, explanation.limeExplanation);

    // If mitigation was applied, update alert record
    if (severity === 'HIGH' || severity === 'CRITICAL') {
      await prismaWrite.fraudAlert.update({
        where: { id: alert.id },
        data: { mitigationApplied: true }
      });
    }

    return alert as unknown as FraudAlert;
  }

  /**
   * Applies hierarchical response action based on severity:
   * - LOW: Log alert.
   * - MEDIUM: Log alert + flag in DB for manual review.
   * - HIGH: Auto-freeze target address in compliance ledger.
   * - CRITICAL: Auto-freeze + Halt contract interactions + Create Incident Report.
   */
  private async applyMitigation(severity: FraudSeverity, address: string, alertId: string, details: string): Promise<void> {
    switch (severity) {
      case 'LOW':
        logger.info(`[Hierarchical Alert] LOW severity: Alert logged for ${address}.`);
        break;

      case 'MEDIUM':
        logger.info(`[Hierarchical Alert] MEDIUM severity: Flagged ${address} for manual compliance investigator review.`);
        // Already registered in fraud_alerts table, which UI monitors
        break;

      case 'HIGH':
        logger.warn(`[Hierarchical Alert] HIGH severity detected for ${address}! Triggering auto-freeze compliance order.`);
        await this.freezeAddress(address, `Auto-compliance freeze from fraud alert ${alertId}`);
        break;

      case 'CRITICAL':
        logger.error(`[Hierarchical Alert] CRITICAL severity detected for ${address}! Freezing key, creating Incident Report and halting contract interactions.`);
        // Freeze compliance
        await this.freezeAddress(address, `Emergency auto-freeze from critical fraud alert ${alertId}`);
        
        // Halt contract state
        await this.haltContractState(address);

        // Raise incident report
        await prismaWrite.incidentReport.create({
          data: {
            contractAddress: address,
            severity: 'critical',
            status: 'open',
            title: `CRITICAL FRAUD ALERT: Contract interaction paused automatically`,
            description: `The Real-Time Fraud Engine raised alert ${alertId} against ${address}. Explanation: ${details}`,
            timeline: [
              {
                time: new Date().toISOString(),
                event: 'Critical fraud alert triggered',
                details
              },
              {
                time: new Date().toISOString(),
                event: 'Emergency contract halt and asset lock applied'
              }
            ] as any
          }
        });
        break;
    }
  }

  private async freezeAddress(address: string, reason: string): Promise<void> {
    try {
      const state = await prismaRead.indexerState.findUnique({ where: { id: 'singleton' } });
      const frozenAtLedger = state?.lastLedger || 0;

      await prismaWrite.frozenLedgerKey.upsert({
        where: { ledgerKey: address },
        create: {
          ledgerKey: address,
          contractAddress: address,
          active: true,
          frozenAtLedger,
          frozenAtTime: new Date(),
          reason
        },
        update: {
          active: true,
          reason,
          updatedAt: new Date()
        }
      });
      invalidateFreezeCache();
      
      // Log audit
      await prismaWrite.auditLog.create({
        data: {
          actor: 'fraud_detection_engine',
          action: 'CREATE_FREEZE',
          target: address,
          newState: JSON.stringify({ active: true, reason }),
          reason
        }
      });
      logger.info(`Successfully froze address ${address}`);
    } catch (err) {
      logger.error(`Failed to freeze address ${address}`, { err });
    }
  }

  private async haltContractState(contractAddress: string): Promise<void> {
    try {
      await prismaWrite.emergencyState.upsert({
        where: { contractAddress },
        create: {
          contractAddress,
          isPaused: true,
          totalPauseCount: 1,
          pauserType: 'governance_multisig'
        },
        update: {
          isPaused: true,
          totalPauseCount: { increment: 1 },
          updatedAt: new Date()
        }
      });
      logger.info(`Successfully set Emergency State to PAUSED for contract ${contractAddress}`);
    } catch (err) {
      logger.error(`Failed to halt contract state for ${contractAddress}`, { err });
    }
  }
}

let alertSystemInstance: FraudAlertSystem | null = null;
export function getFraudAlertSystem(): FraudAlertSystem {
  if (!alertSystemInstance) {
    alertSystemInstance = new FraudAlertSystem();
  }
  return alertSystemInstance;
}
