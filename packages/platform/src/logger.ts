import { pino, type Logger } from 'pino';
import { trace } from '@opentelemetry/api';
import { tryCurrentContext } from './context';

export type { Logger };

/**
 * Structured JSON logger. Every line carries the correlation ID and, when tracing is active,
 * the trace and span IDs, so logs, traces and audit records can be joined.
 */
export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'message',
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.secret',
        '*.signingSecret',
        '*.token',
        '*.accessToken',
        '*.refreshToken',
      ],
      censor: '[redacted]',
    },
    mixin() {
      const ctx = tryCurrentContext();
      const span = trace.getActiveSpan()?.spanContext();
      return {
        ...(ctx ? { correlationId: ctx.correlationId, actor: ctx.principal.subject } : {}),
        ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
      };
    },
  });
}
