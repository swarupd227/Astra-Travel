import { metrics, type Counter, type Histogram } from '@opentelemetry/api';

/**
 * Platform metrics, exported through OpenTelemetry (Grafana locally, Azure Monitor in the cloud).
 * The dead-letter counter drives the "Event deliveries dead-lettered" alert rule
 * (infra/docker/grafana/provisioning/alerting/astra.yaml).
 */
const meter = metrics.getMeter('astra.platform');

/** Seconds; boundaries chosen around the 500 ms quote and 1 s bind targets (specification §14). */
const API_LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 2, 5, 10];

let instruments:
  | {
      apiRequestDuration: Histogram;
      eventsRelayed: Counter;
      deliveriesSucceeded: Counter;
      deliveriesFailed: Counter;
      deliveriesDeadLettered: Counter;
      deliveryDuration: Histogram;
      integrationCalls: Counter;
      integrationDuration: Histogram;
      auditSeals: Counter;
    }
  | undefined;

export function platformMetrics() {
  instruments ??= {
    apiRequestDuration: meter.createHistogram('astra.api.request.duration', {
      description: 'API request duration by route template, method and status code',
      unit: 's',
      advice: { explicitBucketBoundaries: API_LATENCY_BUCKETS },
    }),
    eventsRelayed: meter.createCounter('astra.events.relayed', {
      description: 'Events moved from the outbox to subscriber delivery queues',
    }),
    deliveriesSucceeded: meter.createCounter('astra.events.deliveries.succeeded'),
    deliveriesFailed: meter.createCounter('astra.events.deliveries.failed', {
      description: 'Delivery attempts that failed and will be retried',
    }),
    deliveriesDeadLettered: meter.createCounter('astra.events.deliveries.dead_lettered', {
      description: 'Deliveries that exhausted retries and need attention',
    }),
    deliveryDuration: meter.createHistogram('astra.events.delivery.duration', { unit: 'ms' }),
    integrationCalls: meter.createCounter('astra.integration.calls', {
      description: 'Outbound integration calls by integration and outcome',
    }),
    integrationDuration: meter.createHistogram('astra.integration.duration', { unit: 'ms' }),
    auditSeals: meter.createCounter('astra.audit.seals', {
      description: 'Audit seals written to the hash chain',
    }),
  };
  return instruments;
}
