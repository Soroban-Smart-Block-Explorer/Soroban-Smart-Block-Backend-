/**
 * OpenTelemetry SDK initialisation.
 * Must be imported BEFORE any other application code (see src/index.ts top).
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

const OTLP_ENDPOINT = process.env.OTLP_ENDPOINT ?? 'http://localhost:4318';
const SERVICE_NAME = process.env.SERVICE_NAME ?? 'soroban-block-explorer';
const SERVICE_VERSION = process.env.npm_package_version ?? '1.0.0';

const resource = new Resource({
  [SEMRESATTRS_SERVICE_NAME]: SERVICE_NAME,
  [SEMRESATTRS_SERVICE_VERSION]: SERVICE_VERSION,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sdk = new NodeSDK({
  resource: resource as any, // duplicate @opentelemetry/resources versions in sub-packages
  traceExporter: new OTLPTraceExporter({ url: `${OTLP_ENDPOINT}/v1/traces` }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

process.on('SIGTERM', () => sdk.shutdown().catch(() => {}));

export const tracer = trace.getTracer(SERVICE_NAME, SERVICE_VERSION);

/** Run fn inside a named span; sets ERROR status on throw. */
export async function withSpan<T>(
  name: string,
  fn: (span: ReturnType<typeof tracer.startSpan>) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

export { trace, SpanStatusCode };
