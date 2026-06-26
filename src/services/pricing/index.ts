export {
  discoverDexPrice,
  computeVolumeWeightedMedian,
  estimateSlippage,
  computeTWAP,
  detectPoolManipulation,
  isFlashLoanSwap,
  type DexPrice,
} from './dex-price-source';
export { discoverExternalPrice, type ExternalPrice } from './external-api-source';
export { computeCompositePrice, computeBatchPrices, type CompositePrice } from './composite-price';
export {
  getStablecoinInfo,
  isStablecoin,
  calculatePegDeviation,
  detectFlashCrash,
  computePegStabilityScore,
  autoDetectStablecoin,
  updateStablecoinMonitoring,
} from './stablecoin-peg';
export {
  computeSMA,
  computeEMA,
  computeRSI,
  computeMACD,
  computeBollingerBands,
  computeAllIndicators,
  type TechnicalIndicators,
} from './indicators';
export {
  valuatePortfolio,
  computePortfolioHistory,
  type PortfolioValuation,
  type PortfolioHolding,
  type PortfolioHistoryPoint,
} from './portfolio';
export {
  getCrossChainPrices,
  findArbitrageOpportunities,
  type CrossChainPrice,
  type ArbitrageOpportunity,
} from './correlation';
export { startPriceUpdater, stopPriceUpdater, runActivePriceUpdate } from './price-updater';
