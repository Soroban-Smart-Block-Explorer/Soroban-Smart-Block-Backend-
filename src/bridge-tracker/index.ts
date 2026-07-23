export { detectBridgeTransactions, scanBlockForBridges } from './detector';
export {
  resolveBridgeTransaction,
  storeBridgeTransaction,
  pollAndResolvePending,
} from './resolver';
export {
  checkFinality,
  updateTransactionFinality,
  getStaleTransactions,
  recordArrivalTime,
} from './finality';
export {
  getVolumeByProtocol,
  getVolumeByChain,
  getVolumeByAsset,
  getActivityTrends,
  getFeeComparison,
  aggregateVolumeSnapshot,
} from './liquidity';
export {
  checkLargeTransfer,
  checkBridgeDelay,
  checkBridgeFailure,
  checkMonitoredAddressActivity,
  getAlerts,
  acknowledgeAlert,
  addMonitoredAddress,
  removeMonitoredAddress,
  listMonitoredAddresses,
  runAlertChecks,
} from './alerts';
export {
  processBridgeEvent,
  startBridgeWorker,
  stopBridgeWorker,
  isBridgeWorkerRunning,
} from './worker';
export { BRIDGE_CONTRACTS, CHAIN_PROVIDERS, ALERT_CONFIG } from './config';
export type {
  BridgeProtocol,
  Chain,
  BridgeStatus,
  BridgeEvent,
  DetectionResult,
  FinalityInfo,
  VolumeStats,
  ActivityTrend,
  FeeComparison,
  BridgeAlertEntry,
  MonitoredAddressEntry,
  AlertType,
  AlertSeverity,
} from './types';
