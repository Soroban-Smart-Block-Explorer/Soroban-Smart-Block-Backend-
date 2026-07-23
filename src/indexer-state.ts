let indexerHealthy = true;
let indexerFailureReason: string | undefined;

export function setIndexerFailed(reason: string): void {
  indexerHealthy = false;
  indexerFailureReason = reason;
}

export function setIndexerHealthy(): void {
  indexerHealthy = true;
  indexerFailureReason = undefined;
}

export function getIndexerStatus(): { healthy: boolean; failureReason?: string } {
  return { healthy: indexerHealthy, failureReason: indexerFailureReason };
}
