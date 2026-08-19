/**
 * Static region topology (Issue #556: "5+ regional deployments").
 *
 * This is deployment metadata, not a live service registry — actual
 * inter-region networking (anycast DNS, global load balancer health checks)
 * is infrastructure configuration owned outside this repo. What the app
 * needs to know locally is: which region it's running as, which regions
 * exist, and which regions house EU data for the `?region=eu` sovereignty
 * filter (Issue #556 "Compliance & Auditing").
 */

export type RegionId = 'us-east' | 'eu-west' | 'ap-southeast' | 'sa-east' | 'af-south';

export interface RegionInfo {
  id: RegionId;
  /** ISO-ish jurisdiction tag used for data-locality filtering, e.g. `?region=eu`. */
  jurisdiction: 'us' | 'eu' | 'apac' | 'sa' | 'af';
}

export const REGIONS: Record<RegionId, RegionInfo> = {
  'us-east': { id: 'us-east', jurisdiction: 'us' },
  'eu-west': { id: 'eu-west', jurisdiction: 'eu' },
  'ap-southeast': { id: 'ap-southeast', jurisdiction: 'apac' },
  'sa-east': { id: 'sa-east', jurisdiction: 'sa' },
  'af-south': { id: 'af-south', jurisdiction: 'af' },
};

const JURISDICTION_ALIASES: Record<string, RegionInfo['jurisdiction']> = {
  eu: 'eu',
  us: 'us',
  apac: 'apac',
  'ap-southeast': 'apac',
  sa: 'sa',
  af: 'af',
};

export function resolveJurisdiction(raw: string): RegionInfo['jurisdiction'] | undefined {
  return JURISDICTION_ALIASES[raw.toLowerCase().trim()];
}

/** The region this process is running as, from `DEPLOY_REGION` (falls back to `us-east` for local dev). */
export function currentRegion(): RegionId {
  const raw = (process.env.DEPLOY_REGION ?? 'us-east') as RegionId;
  return raw in REGIONS ? raw : 'us-east';
}
