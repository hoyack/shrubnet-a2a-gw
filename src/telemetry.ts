/** OpenTelemetry traces, metrics and logs.
 * - Default: JSONL files under GATEWAY_TELEMETRY_DIR (default ./telemetry), rotated daily at UTC midnight, 7 kept.
 * - OTEL_EXPORTER_OTLP_ENDPOINT set: OTLP/HTTP INSTEAD of the files (standard OTEL_* env vars apply).
 *   http:// to a non-local host logs a plaintext warning.
 * Telemetry carries IDs, method, status and timing only, never message or reply text. */
import * as fs from 'fs';
import * as path from 'path';
import { context, metrics, trace, Span } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { ExportResult, ExportResultCode, hrTimeToMilliseconds } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor, ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, PeriodicExportingMetricReader, PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { LOG } from './log';
import { pyDumps } from './py';

const TELEMETRY_DIR = process.env.GATEWAY_TELEMETRY_DIR || 'telemetry';
const OTLP_ENDPOINT = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').trim();
const RETENTION_DAYS = 7;

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Appends lines to <dir>/<name>.jsonl; at the first write of a new UTC day the file becomes <name>.jsonl.YYYY-MM-DD
 * and only the newest RETENTION_DAYS backups are kept (same scheme as Python's TimedRotatingFileHandler).
 * Assumes a single process writes the directory. */
class DailyFile {
  private readonly file: string;
  private day: string;
  constructor(private readonly name: string) {
    this.file = path.join(TELEMETRY_DIR, `${name}.jsonl`);
    this.day = fs.existsSync(this.file) ? utcDay(fs.statSync(this.file).mtimeMs) : utcDay(Date.now());
  }
  write(line: string) {
    const today = utcDay(Date.now());
    if (today !== this.day) {
      if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.${this.day}`);
      this.day = today;
      const backups = fs.readdirSync(TELEMETRY_DIR).filter((f) => /^\d{4}-\d\d-\d\d$/.test(f.slice(this.name.length + 7))
        && f.startsWith(`${this.name}.jsonl.`)).sort();
      for (const f of backups.slice(0, Math.max(0, backups.length - RETENTION_DAYS))) fs.unlinkSync(path.join(TELEMETRY_DIR, f));
    }
    fs.appendFileSync(this.file, line + '\n');
  }
}

const iso = (hr: [number, number]) => new Date(hrTimeToMilliseconds(hr)).toISOString();

class FileSpanExporter implements SpanExporter {
  private out = new DailyFile('traces');
  export(spans: ReadableSpan[], done: (r: ExportResult) => void) {
    for (const s of spans) {
      const ctx = s.spanContext();
      this.out.write(pyDumps({
        name: s.name,
        context: { trace_id: ctx.traceId, span_id: ctx.spanId },
        parent_id: s.parentSpanContext?.spanId ?? null,
        start_time: iso(s.startTime), end_time: iso(s.endTime),
        status: { status_code: s.status.code, description: s.status.message ?? null },
        attributes: s.attributes,
        resource: s.resource.attributes,
      }));
    }
    done({ code: ExportResultCode.SUCCESS });
  }
  async shutdown() {}
}

class FileMetricExporter implements PushMetricExporter {
  private out = new DailyFile('metrics');
  export(rm: ResourceMetrics, done: (r: ExportResult) => void) {
    this.out.write(pyDumps({
      scope_metrics: rm.scopeMetrics.map((s) => ({
        scope: s.scope.name,
        metrics: s.metrics.map((m) => ({
          name: m.descriptor.name, unit: m.descriptor.unit,
          data_points: m.dataPoints.map((dp) => ({ attributes: dp.attributes, value: dp.value as any })),
        })),
      })),
    }));
    done({ code: ExportResultCode.SUCCESS });
  }
  async forceFlush() {}
  async shutdown() {}
}

let eventsFile: DailyFile | null = null;
let tracerProvider: BasicTracerProvider;
let meterProvider: MeterProvider;
let loggerProvider: LoggerProvider | null = null;

function warnIfPlaintext(endpoint: string) {
  try {
    const u = new URL(endpoint);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(host)) {
      LOG.warning(`OTEL_EXPORTER_OTLP_ENDPOINT uses http:// to non-local host ${host}; telemetry is sent unencrypted`);
    }
  } catch { /* exporter reports a bad URL itself */ }
}

let initialized = false;

/** Called from main before the app is created. Idempotent: later calls are no-ops, so providers and
 * the context manager are registered exactly once. Returns true only on the call that initialized. */
export function setup(): boolean {
  if (initialized) return false;
  initialized = true;
  const resource = resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME || 'kimiclaw-a2a-gateway' });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  if (OTLP_ENDPOINT) {
    warnIfPlaintext(OTLP_ENDPOINT);
    tracerProvider = new BasicTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())] });
    meterProvider = new MeterProvider({ resource, readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })] });
    loggerProvider = new LoggerProvider({ resource, processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })] });
    logs.setGlobalLoggerProvider(loggerProvider);
  } else {
    fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
    tracerProvider = new BasicTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(new FileSpanExporter())] });
    meterProvider = new MeterProvider({ resource, readers: [new PeriodicExportingMetricReader({ exporter: new FileMetricExporter(), exportIntervalMillis: 60_000 })] });
    eventsFile = new DailyFile('logs');
  }
  trace.setGlobalTracerProvider(tracerProvider);
  metrics.setGlobalMeterProvider(meterProvider);
  return true;
}

export const tracer = () => trace.getTracer('kimiclaw');
const meter = () => metrics.getMeter('kimiclaw');
let instruments: ReturnType<typeof makeInstruments>;
function makeInstruments() {
  const m = meter();
  return {
    requests: m.createCounter('gateway.requests', { description: 'HTTP requests' }),
    requestMs: m.createHistogram('gateway.request.duration', { unit: 'ms' }),
    agentMs: m.createHistogram('gateway.agent.duration', { unit: 'ms' }),
    notifyFailures: m.createCounter('gateway.notify.failures'),
    breakerOpens: m.createCounter('gateway.notify.breaker_opens'),
  };
}
export const metric = () => (instruments ??= makeInstruments());

/** Structured telemetry event (logs.jsonl or OTLP logs), stamped with the active trace/span ids. */
export function event(name: string, fields: Record<string, unknown>) {
  const ctx = trace.getActiveSpan()?.spanContext();
  if (eventsFile) {
    const doc: Record<string, unknown> = { ts: new Date().toISOString(), level: 'INFO', event: name };
    if (ctx) Object.assign(doc, { trace_id: ctx.traceId, span_id: ctx.spanId });
    eventsFile.write(pyDumps({ ...doc, ...fields }));
  } else {
    logs.getLogger('kimiclaw').emit({ severityNumber: SeverityNumber.INFO, severityText: 'INFO', body: name, attributes: fields as any });
  }
}

/** Express middleware: one "rpc" span per request, closed when the response ends (so SSE spans cover the stream). */
export function telemetryMiddleware(req: any, res: any, next: () => void) {
  const started = performance.now();
  const span: Span = tracer().startSpan('rpc', { attributes: { 'http.request.method': req.method, 'url.path': req.path } });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    const ms = performance.now() - started;
    const status = res.headersSent ? res.statusCode : 500;
    span.setAttribute('http.response.status_code', status);
    const attrs = { 'http.request.method': req.method, 'http.response.status_code': status };
    metric().requests.add(1, attrs);
    metric().requestMs.record(ms, attrs);
    context.with(trace.setSpan(context.active(), span), () =>
      event('http_request', { method: req.method, path: req.path, status, duration_ms: Math.round(ms * 10) / 10, ...(res.locals.ids || {}) }));
    span.end();
  };
  res.on('finish', finish);
  res.on('close', finish);
  context.with(trace.setSpan(context.active(), span), next);
}

export async function shutdown() {
  await Promise.allSettled([tracerProvider?.shutdown(), meterProvider?.shutdown(), loggerProvider?.shutdown()]);
}
