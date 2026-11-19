/**
 * OpenTelemetry bootstrap. Load before any other module (`node --import @astra/platform/telemetry`
 * or the app's own preload) so HTTP, Fastify and pg are instrumented. Traces, metrics and logs go to
 * the OTLP endpoint (Grafana LGTM locally, Azure Monitor via the OTel distro in the cloud).
 * Telemetry is disabled when OTEL_EXPORTER_OTLP_ENDPOINT is not set.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';

import { register } from 'node:module';

let sdk: NodeSDK | undefined;

export function startTelemetry(serviceName: string): void {
  if (sdk || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  // Hook ES module loading so modules imported after this point (http, fastify, pg) are instrumented.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 15_000,
      }),
    ],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });
  sdk.start();
}

export async function stopTelemetry(): Promise<void> {
  await sdk?.shutdown().catch(() => undefined);
  sdk = undefined;
}
