/**
 * Log shipping configuration.
 *
 * When LOG_SHIPPING_ENABLED=true the logger writes structured JSON to stdout
 * (already the default). Configure your log collector agent to tail stdout:
 *
 * ELK (Filebeat):
 *   filebeat.inputs:
 *     - type: container
 *       paths: ['/var/lib/docker/containers/**\/*.log']
 *       processors:
 *         - decode_json_fields:
 *             fields: ['message']
 *             target: ''
 *       output.elasticsearch:
 *         hosts: ['${ELASTICSEARCH_URL}']
 *         index: 'soroban-explorer-%{+yyyy.MM.dd}'
 *
 * Datadog:
 *   env DD_LOGS_ENABLED=true
 *   env DD_LOGS_CONFIG_CONTAINER_COLLECT_ALL=true
 *   Labels:
 *     com.datadoghq.ad.logs: '[{"source":"nodejs","service":"soroban-block-explorer"}]'
 *
 * The log format already includes:  level, message, timestamp,
 *   requestId, traceId, spanId — all fields expected by both collectors.
 *
 * Sampling (high-traffic endpoints):
 *   Set LOG_SAMPLE_RATE=0.1 to emit ~10 % of debug logs on /api/v1/events and
 *   /api/v1/transactions. Set to 1 (default) to emit all.
 */

export const LOG_SHIPPING_ENABLED = process.env.LOG_SHIPPING_ENABLED === 'true';

/** Sampling rate for high-volume debug logs (0–1). */
export const LOG_SAMPLE_RATE = parseFloat(process.env.LOG_SAMPLE_RATE ?? '1');

/** Endpoints where sampling is applied. */
export const SAMPLED_PATHS = ['/api/v1/events', '/api/v1/transactions'];

export function shouldSample(path: string): boolean {
  if (LOG_SAMPLE_RATE >= 1) return true;
  if (SAMPLED_PATHS.some((p) => path.startsWith(p))) {
    return Math.random() < LOG_SAMPLE_RATE;
  }
  return true;
}
