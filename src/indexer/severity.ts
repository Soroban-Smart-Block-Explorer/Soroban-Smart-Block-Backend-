export type Severity = 'low' | 'medium' | 'high' | 'critical';

export const SEVERITY_MULTIPLIER: Record<Severity, number> = {
  low: 0.02,
  medium: 0.1,
  high: 0.5,
  critical: 1.0,
};
