export type Role = 'user' | 'developer' | 'premium' | 'admin' | 'super_admin';
export type Tier = 'free' | 'developer' | 'premium' | 'enterprise';

interface TierConfig {
  rateLimit: { perMinute: number; burst: number };
  webhooks: number | 'unlimited';
  dashboards: number | 'unlimited';
  dataExport: string[];
  multiSigAuth: boolean;
  customBranding: boolean;
  prioritySupport: boolean;
  tokenThreshold: number;
}

export const TIER_CONFIG: Record<Tier, TierConfig> = {
  free:       { rateLimit: { perMinute: 10,    burst: 20    }, webhooks: 0,           dashboards: 1,           dataExport: [],                    multiSigAuth: false, customBranding: false, prioritySupport: false, tokenThreshold: 0     },
  developer:  { rateLimit: { perMinute: 100,   burst: 200   }, webhooks: 3,           dashboards: 3,           dataExport: ['csv'],                multiSigAuth: true,  customBranding: false, prioritySupport: false, tokenThreshold: 100   },
  premium:    { rateLimit: { perMinute: 1000,  burst: 2000  }, webhooks: 10,          dashboards: 10,          dataExport: ['csv', 'json'],        multiSigAuth: true,  customBranding: false, prioritySupport: true,  tokenThreshold: 1000  },
  enterprise: { rateLimit: { perMinute: 10000, burst: 20000 }, webhooks: 'unlimited', dashboards: 'unlimited', dataExport: ['csv', 'json', 'all'], multiSigAuth: true,  customBranding: true,  prioritySupport: true,  tokenThreshold: 10000 },
};

export function tierFromTokenHolding(tokenBalance: number): Tier {
  if (tokenBalance >= 10000) return 'enterprise';
  if (tokenBalance >= 1000)  return 'premium';
  if (tokenBalance >= 100)   return 'developer';
  return 'free';
}

export function getFeatures(tier: Tier) {
  const cfg = TIER_CONFIG[tier];
  return {
    webhooks:     { max: cfg.webhooks,    enabled: cfg.webhooks !== 0 },
    dashboards:   { max: cfg.dashboards,  enabled: true },
    dataExport:   cfg.dataExport,
    multiSigAuth: cfg.multiSigAuth,
    customBranding: cfg.customBranding,
    prioritySupport: cfg.prioritySupport,
    rateLimit:    cfg.rateLimit,
  };
}

export function featureList(tier: Tier): string[] {
  const f = getFeatures(tier);
  const features: string[] = [];
  if (f.webhooks.enabled)   features.push('webhooks');
  if (f.multiSigAuth)       features.push('multi_sig_auth');
  if (f.dataExport.length)  features.push('data_export');
  if (f.customBranding)     features.push('custom_branding');
  if (f.prioritySupport)    features.push('priority_rate_limit');
  return features;
}

export const ROLE_HIERARCHY: Record<Role, number> = {
  user: 0,
  developer: 1,
  premium: 2,
  admin: 3,
  super_admin: 4,
};

export function hasRole(userRole: Role, required: Role): boolean {
  return (ROLE_HIERARCHY[userRole] ?? 0) >= (ROLE_HIERARCHY[required] ?? 0);
}
