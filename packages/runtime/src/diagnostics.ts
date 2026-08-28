import type { DiagnosticRecord, DiagnosticSeverity } from "./types.js";
import { compactRuntimeDiagnostics } from "./runtime-diagnostics.js";

type MutableDiagnosticRecord = {
  -readonly [Key in keyof DiagnosticRecord]: DiagnosticRecord[Key];
};

const DIAGNOSTIC_WINDOW_MS = 60_000;
const DIAGNOSTIC_LIMIT = 64;
const DIAGNOSTIC_ERROR_RESERVE = 8;

export interface DiagnosticInput {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  phase: DiagnosticRecord["phase"];
  overrideId?: string;
  eventId?: number;
  metadata?: Readonly<Record<string, string | number | boolean>>;
  cause?: unknown;
}

export class DiagnosticChannel {
  readonly #instanceId: string;
  readonly #now: () => number;
  readonly #logger: ((record: Readonly<DiagnosticRecord>) => void) | undefined;
  readonly #messageSink: ((message: string) => void) | undefined;
  readonly #context:
    Readonly<Record<string, string | number | boolean>> | undefined;
  readonly #debug: boolean;
  readonly #console: boolean | undefined;
  #sequence = 0;
  #window: number[] = [];
  #overflowErrors: number[] = [];
  #rateLimitSignal: number | undefined;
  #logging = false;

  constructor(options: {
    instanceId: string;
    now: () => number;
    logger?: (record: Readonly<DiagnosticRecord>) => void;
    messageSink?: (message: string) => void;
    context?: Readonly<Record<string, string | number | boolean>>;
    debug?: boolean;
    console?: boolean;
  }) {
    this.#instanceId = options.instanceId;
    this.#now = options.now;
    this.#logger = options.logger;
    this.#messageSink = options.messageSink;
    this.#context = options.context;
    this.#debug = options.debug === true;
    this.#console = options.console;
  }

  emit(input: Readonly<DiagnosticInput>): DiagnosticRecord | undefined {
    const now = this.#now();
    this.#window = this.#window.filter(
      (time) => now - time < DIAGNOSTIC_WINDOW_MS,
    );
    this.#overflowErrors = this.#overflowErrors.filter(
      (time) => now - time < DIAGNOSTIC_WINDOW_MS,
    );
    if (
      this.#rateLimitSignal !== undefined &&
      now - this.#rateLimitSignal >= DIAGNOSTIC_WINDOW_MS
    ) {
      this.#rateLimitSignal = undefined;
    }
    if (this.#logging) return undefined;
    if (this.#window.length >= DIAGNOSTIC_LIMIT) {
      if (this.#rateLimitSignal === undefined) {
        this.#rateLimitSignal = now;
        this.#deliver({
          code: "diagnostics.rate-limited",
          severity: "warning",
          message: "Diagnostic output was rate limited",
          phase: "internal",
          metadata: {
            windowMs: DIAGNOSTIC_WINDOW_MS,
            recordLimit: DIAGNOSTIC_LIMIT,
            errorReserve: DIAGNOSTIC_ERROR_RESERVE,
          },
        });
      }
      if (
        input.severity !== "error" ||
        this.#overflowErrors.length >= DIAGNOSTIC_ERROR_RESERVE
      ) {
        return undefined;
      }
      this.#overflowErrors.push(now);
      return this.#deliver(input);
    }
    this.#window.push(now);
    return this.#deliver(input);
  }

  #deliver(input: Readonly<DiagnosticInput>): DiagnosticRecord {
    const record: MutableDiagnosticRecord = {
      code: input.code,
      severity: input.severity,
      message: sanitizeMessage(input.message),
      phase: input.phase,
      sequence: ++this.#sequence,
      timestamp: Date.now(),
      instanceId: this.#instanceId,
    };
    if (input.overrideId) record.overrideId = input.overrideId;
    if (input.eventId !== undefined) record.eventId = input.eventId;
    if (input.metadata) record.metadata = input.metadata;
    if (this.#context) record.context = this.#context;
    if (this.#debug && input.cause) record.cause = diagnosticCause(input.cause);
    this.#logging = true;
    try {
      try {
        this.#messageSink?.(record.message);
      } catch {}
      try {
        this.#logger?.(record);
      } catch {}
    } finally {
      this.#logging = false;
    }
    if (
      !this.#messageSink &&
      !this.#logger &&
      (this.#console === true ||
        (this.#console === undefined && record.severity === "error"))
    ) {
      console.warn(
        `[Peekling] ${record.message}${
          compactRuntimeDiagnostics && record.severity === "error"
            ? " (use peekling.js for details)"
            : ""
        }`,
      );
    }
    return record;
  }
}

function sanitizeMessage(value: string): string {
  return value
    .replace(/https?:\/\/[^\s]+/gi, "[redacted-url]")
    .replace(/\b(token|secret|password|authorization)=\S+/gi, "$1=[redacted]")
    .slice(0, 500);
}

function diagnosticCause(
  value: unknown,
): NonNullable<DiagnosticRecord["cause"]> {
  if (value instanceof Error) {
    return {
      name: value.name.slice(0, 80),
      message: value.message.slice(0, 500),
      ...(value.stack ? { stack: value.stack.slice(0, 4_000) } : {}),
    };
  }
  return { name: "Error", message: String(value).slice(0, 500) };
}
