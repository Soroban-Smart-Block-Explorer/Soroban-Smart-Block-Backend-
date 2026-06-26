import { logger } from '../../logger';

export type AuditAction =
  | 'screen_address'
  | 'review_alert'
  | 'generate_report'
  | 'import_list'
  | 'refresh_lists'
  | 'delete_list'
  | 'submit_travel_rule'
  | 'register_webhook'
  | 'create_blocking_rule'
  | 'batch_screen'
  | 'risk_assessment'
  | 'sar_filing'
  | 'regulatory_filing'
  | 'anomaly_review'
  | 'cluster_analysis';

interface AuditEntry {
  action: AuditAction;
  actor?: string;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ip?: string;
}

export const auditLog: AuditEntry[] = [];

export function recordAudit(entry: AuditEntry): void {
  auditLog.push({
    ...entry,
  });
  logger.info(`Audit: ${entry.action}`, {
    actor: entry.actor,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    details: entry.details,
  });
}

export function getAuditLogs(filters?: {
  action?: AuditAction;
  actor?: string;
  limit?: number;
  offset?: number;
}): AuditEntry[] {
  let logs = [...auditLog];
  if (filters?.action) {
    logs = logs.filter((l) => l.action === filters.action);
  }
  if (filters?.actor) {
    logs = logs.filter((l) => l.actor === filters.actor);
  }
  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;
  return logs.slice(offset, offset + limit);
}

export function clearAuditLogs(): void {
  auditLog.length = 0;
}
