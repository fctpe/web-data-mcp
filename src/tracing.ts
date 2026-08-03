import type { McpServer } from '@modelcontextprotocol/server';
import type { DiagLogger, SpanStatusCode, Tracer } from '@opentelemetry/api';

/**
 * OTLP/HTTP is hard-wired. This server speaks MCP over stdio, so a span exporter
 * that writes to stdout would corrupt the protocol stream — which is exactly what
 * @opentelemetry/sdk-node does when OTEL_TRACES_EXPORTER=console. Constructing the
 * exporter here instead of letting the SDK auto-select one makes that unreachable.
 */
const REQUIRED_PACKAGES =
  '@opentelemetry/api @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http';

interface ActiveTracing {
  tracer: Tracer;
  errorStatus: SpanStatusCode;
  shutdown: () => Promise<void>;
  silenceDiag: () => void;
}

let active: ActiveTracing | null = null;

/**
 * The exporter resolves its URL from OTEL_EXPORTER_OTLP_TRACES_ENDPOINT and falls
 * back to OTEL_EXPORTER_OTLP_ENDPOINT, counting a blank value as unset. The guard
 * below has to read the same two in the same order, or it vets a URL the exporter
 * never uses: a `grpc://` traces override next to a valid base endpoint would
 * otherwise pass the check and then export nothing, anywhere, silently.
 */
const ENDPOINT_VARS = [
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
] as const;

function endpointFromEnv(): { variable: string; value: string } | null {
  for (const variable of ENDPOINT_VARS) {
    const value = process.env[variable];
    if (value !== undefined && value.trim() !== '') return { variable, value };
  }
  return null;
}

function isOtlpHttpUrl(endpoint: string): boolean {
  try {
    const { protocol } = new URL(endpoint);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Everything that goes wrong after startup — a 401, a refused connection, a retry
 * ladder that ran out — is reported through diag, and diag discards it unless a
 * logger is registered. Not DiagConsoleLogger: it routes info to console.info and
 * debug to console.debug, both of which are stdout in Node, and stdout is the MCP
 * protocol stream. Every level here goes to stderr, so raising the level can never
 * corrupt that stream.
 */
function stderrDiagLogger(): DiagLogger {
  const toStderr =
    (level: string) =>
    (message: string, ...args: unknown[]): void => {
      console.error(`[otel ${level}] ${message}`, ...args);
    };
  return {
    error: toStderr('error'),
    warn: toStderr('warn'),
    info: toStderr('info'),
    debug: toStderr('debug'),
    verbose: toStderr('verbose'),
  };
}

/**
 * Starts tracing when an OTLP endpoint is configured. No endpoint is a hard no-op:
 * the SDK is never imported, so it does not need to be installed at all.
 * Returns whether tracing is on.
 */
export async function startTracing(name: string, version: string): Promise<boolean> {
  if (active) return true;
  const endpoint = endpointFromEnv();
  if (!endpoint) return false;
  if (!isOtlpHttpUrl(endpoint.value)) {
    // The exporter would accept this and drop every span without a sound.
    console.error(
      `${endpoint.variable}="${endpoint.value}" is not an http(s) URL — tracing is OFF.`,
    );
    return false;
  }

  let api: typeof import('@opentelemetry/api');
  let sdk: typeof import('@opentelemetry/sdk-trace-base');
  let otlp: typeof import('@opentelemetry/exporter-trace-otlp-http');
  try {
    [api, sdk, otlp] = await Promise.all([
      import('@opentelemetry/api'),
      import('@opentelemetry/sdk-trace-base'),
      import('@opentelemetry/exporter-trace-otlp-http'),
    ]);
  } catch (err) {
    // Say so rather than running untraced while the operator believes otherwise.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `${endpoint.variable} is set but tracing is OFF — the OpenTelemetry SDK failed to load: ${detail}\n` +
        `Install it with: npm i ${REQUIRED_PACKAGES}`,
    );
    return false;
  }

  // WARN, not INFO: the levels below it narrate every export, payload included,
  // once per tool call. Errors and dropped-span warnings are the whole point here.
  api.diag.setLogger(stderrDiagLogger(), api.DiagLogLevel.WARN);

  // The exporter reads the endpoint, headers and timeout vars itself; service.name
  // comes from OTEL_SERVICE_NAME via the SDK's default resource.
  //
  // Simple, not batched: a span POSTs the moment its tool call ends, so it is
  // queryable while the call it describes is still fresh. The cost is one request
  // per call, with the exporter's 30-request concurrency cap as the only
  // backpressure — the right trade when a tool call is a seconds-long scrape.
  // BatchSpanProcessor would coalesce those requests and bound the queue, and
  // losing buffered spans at exit is NOT the argument against it: its shutdown()
  // force-flushes, and the stop hook in index.ts calls exactly that.
  const provider = new sdk.BasicTracerProvider({
    spanProcessors: [new sdk.SimpleSpanProcessor(new otlp.OTLPTraceExporter())],
  });
  active = {
    tracer: provider.getTracer(name, version),
    errorStatus: api.SpanStatusCode.ERROR,
    shutdown: () => provider.shutdown(),
    silenceDiag: () => api.diag.disable(),
  };
  return true;
}

/**
 * An unreachable collector puts the exporter into a retry ladder bounded only by
 * OTEL_EXPORTER_OTLP_TIMEOUT — 10s by default, longer than an MCP client waits
 * before it gives up on a server and kills it. A span that cannot get out inside
 * this window was never going to.
 */
const SHUTDOWN_GRACE_MS = 2000;

type ShutdownOutcome = { ok: true } | { ok: false; reason: string };

/** Waits for in-flight exports, briefly. Resolves immediately when tracing is off. */
export async function shutdownTracing(): Promise<void> {
  const current = active;
  if (!current) return;
  active = null;
  let grace: ReturnType<typeof setTimeout> | undefined;
  // Losing the race is not the same as flushing, and a rejected shutdown is not a
  // flush either. Both drop spans, so both have to say so instead of resolving void.
  const outcome = await Promise.race<ShutdownOutcome>([
    current.shutdown().then(
      () => ({ ok: true }),
      (err: unknown) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }),
    ),
    new Promise<ShutdownOutcome>((resolve) => {
      grace = setTimeout(
        () => resolve({ ok: false, reason: `still in flight after ${SHUTDOWN_GRACE_MS}ms` }),
        SHUTDOWN_GRACE_MS,
      );
    }),
  ]);
  clearTimeout(grace);
  if (!outcome.ok) console.error(`Tracing shutdown dropped spans — ${outcome.reason}.`);
  // Only now: the final flush is the window where an export error matters most.
  current.silenceDiag();
}

/**
 * scrape_url and validate_dataset report `quality`; retry_low_quality_run reports
 * `final_quality`. Both carry the qualityOutput wire shape from tools/helpers.ts.
 * Tools without a quality block simply get no score attribute.
 */
function qualityScore(structuredContent: unknown): number | undefined {
  if (typeof structuredContent !== 'object' || structuredContent === null) return undefined;
  const result = structuredContent as Record<string, unknown>;
  const block = result.final_quality ?? result.quality;
  if (typeof block !== 'object' || block === null) return undefined;
  const score = (block as Record<string, unknown>).score;
  return typeof score === 'number' ? score : undefined;
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
}

type ToolHandler = (...args: unknown[]) => ToolResult | Promise<ToolResult>;

/** The only part of registerTool's overloaded signature this wrapper depends on. */
type RegisterTool = (name: string, config: unknown, handler: ToolHandler) => unknown;

async function runInSpan(
  tracing: ActiveTracing,
  toolName: string,
  invoke: () => ToolResult | Promise<ToolResult>,
): Promise<ToolResult> {
  // GenAI semantic conventions: span name is "{gen_ai.operation.name} {gen_ai.tool.name}".
  const span = tracing.tracer.startSpan(`execute_tool ${toolName}`, {
    attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': toolName },
  });
  // Deliberately no catch: every tool already returns toolFailure(err), whose message
  // has been through mapApifyError. Recording a raw throw here would be the one path
  // that ships an unsanitized message and stack to an external collector.
  try {
    const result = await invoke();
    const score = qualityScore(result.structuredContent);
    if (score !== undefined) span.setAttribute('web_data_mcp.quality.score', score);
    if (result.isError) {
      span.setStatus({ code: tracing.errorStatus, message: result.content?.[0]?.text ?? '' });
    }
    return result;
  } finally {
    span.end();
  }
}

/**
 * Wraps every tool registered afterwards in a span. Patching the single
 * registration point rather than each tool means a new tool cannot be added
 * untraced by accident. Returns the server untouched when tracing is off, so
 * the disabled path costs nothing at call time.
 */
export function traceToolCalls(server: McpServer): McpServer {
  const tracing = active;
  if (!tracing) return server;

  const register = server.registerTool.bind(server) as RegisterTool;
  const traced: RegisterTool = (name, config, handler) =>
    register(name, config, (...args) => runInSpan(tracing, name, () => handler(...args)));
  server.registerTool = traced as McpServer['registerTool'];
  return server;
}
