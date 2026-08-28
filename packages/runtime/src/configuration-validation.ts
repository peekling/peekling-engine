import { validateHostContent } from "./content.js";
import { isHttpPath, isSurfaceColor, NAME_PATTERN } from "./contracts.js";
import { isRegisteredCharacter } from "./registry.js";
import { compactRuntimeDiagnostics } from "./runtime-diagnostics.js";
import type { PeeklingOptions } from "./runtime.js";
import { validStyleIntegrity } from "./styles.js";
import { CONTENT_REGIONS, type HostContent } from "./types.js";

const collectConfigurationFaults = !compactRuntimeDiagnostics;

const CONFIGURATION_FIELDS = [
  "format",
  "character",
  "pack",
  "packUrl",
  "atlasUrl",
  "styles",
  "plan",
  "content",
  "bindings",
  "theme",
  "accessibility",
  "diagnostics",
  "name",
  "scale",
  "position",
  "density",
  "maxDensity",
  "onDiagnostic",
  "logger",
  "document",
  "window",
];

export type ConfigurationFaultSink = (
  code: string,
  path: string,
  detail?: string,
) => void;

export interface RuntimeConfigurationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class PeeklingPreflightError extends TypeError {
  readonly issues: readonly RuntimeConfigurationIssue[];

  constructor(code: string, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "PeeklingPreflightError";
    this.issues = [{ code, path, message }];
  }
}

/**
 * Validate shared Configuration semantics without selecting presentation prose.
 * A throwing sink is fail-fast. A collecting sink receives every safe fault.
 */
export function validateConfiguration(
  options: PeeklingOptions,
  baseUrl: string,
  fault: ConfigurationFaultSink,
): HostContent {
  closed(options, CONFIGURATION_FIELDS, "$", fault);
  if (
    options.character === undefined &&
    options.pack === undefined &&
    options.packUrl === undefined
  ) {
    reportConfigurationFault("manifest.selection", "$", fault);
  }

  if (options.format !== undefined && options.format !== 1) {
    reportConfigurationFault("unsupported-format", "$.format", fault);
  }
  if (options.character !== undefined) {
    if (
      typeof options.character !== "string" ||
      !NAME_PATTERN.test(options.character)
    ) {
      reportConfigurationFault("invalid-character", "$.character", fault);
    } else if (
      options.pack === undefined &&
      options.packUrl === undefined &&
      !isRegisteredCharacter(options.character)
    ) {
      reportConfigurationFault(
        "character.unknown",
        "$.character",
        fault,
        options.character,
      );
    }
  }
  if (
    options.scale !== undefined &&
    (!Number.isInteger(options.scale) || options.scale < 1 || options.scale > 4)
  ) {
    reportConfigurationFault("out-of-range", "$.scale", fault, "scale");
  }
  for (const field of ["density", "maxDensity"] as const) {
    const value = options[field];
    if (value !== undefined && value !== 1 && value !== 2 && value !== 4) {
      reportConfigurationFault("invalid-density", `$.${field}`, fault, field);
    }
  }
  if (
    options.density !== undefined &&
    options.maxDensity !== undefined &&
    options.density > options.maxDensity
  ) {
    reportConfigurationFault("incompatible-density", "$.density", fault);
  }
  if (!validRuntimeName(options.name)) {
    reportConfigurationFault("invalid-name", "$.name", fault);
  }
  for (const field of ["packUrl", "atlasUrl"] as const) {
    const value = options[field];
    if (value !== undefined && !isHttpPath(value, baseUrl)) {
      reportConfigurationFault("invalid-url", `$.${field}`, fault, field);
    }
  }

  const position = options.position;
  if (
    position !== undefined &&
    position !== "bottom-left" &&
    position !== "bottom-right" &&
    position !== "center"
  ) {
    const point = shape(
      position,
      "invalid-position",
      "$.position",
      ["x", "y"],
      fault,
    );
    if (!collectConfigurationFaults || point) {
      const checked = point!;
      if (
        typeof checked.x !== "number" ||
        !Number.isFinite(checked.x) ||
        Math.abs(checked.x) > 100_000 ||
        typeof checked.y !== "number" ||
        !Number.isFinite(checked.y) ||
        Math.abs(checked.y) > 100_000
      ) {
        reportConfigurationFault("invalid-position", "$.position", fault);
      }
    }
  }

  const styles = options.styles;
  if (styles !== undefined) {
    const checked = shape(
      styles,
      "invalid-styles",
      "$.styles",
      ["url", "integrity"],
      fault,
    );
    if (!collectConfigurationFaults || checked) {
      const validated = checked!;
      if (
        typeof validated.url !== "string" ||
        !isHttpPath(validated.url, baseUrl)
      ) {
        reportConfigurationFault("invalid-styles-url", "$.styles.url", fault);
      }
      if (!validStyleIntegrity(validated.integrity)) {
        reportConfigurationFault(
          "invalid-styles-integrity",
          "$.styles.integrity",
          fault,
        );
      }
    }
  }

  let content!: HostContent;
  try {
    content = validateHostContent(options.content, baseUrl);
  } catch (cause) {
    reportConfigurationFault(
      "invalid-content",
      "$.content",
      fault,
      cause instanceof Error ? cause.message : String(cause),
    );
    if (collectConfigurationFaults) content = {};
  }

  validateBindings(options.bindings, content, fault);
  validateTheme(options.theme, fault);
  validateDiagnostics(options.diagnostics, fault);
  validateAccessibility(options.accessibility, fault);
  for (const field of ["onDiagnostic", "logger"] as const) {
    if (options[field] !== undefined && typeof options[field] !== "function") {
      reportConfigurationFault("invalid-callback", `$.${field}`, fault, field);
    }
  }
  return content;
}

export function validRuntimeName(value: PeeklingOptions["name"]): boolean {
  return value === undefined || typeof value === "boolean" || text(value, 80);
}

function validateBindings(
  bindings: PeeklingOptions["bindings"],
  content: HostContent,
  fault: ConfigurationFaultSink,
): void {
  let mounts: Readonly<Record<string, unknown>> | undefined;
  if (bindings !== undefined) {
    const checked = shape(
      bindings,
      "invalid-bindings",
      "$.bindings",
      ["mounts"],
      fault,
    );
    if (
      (!collectConfigurationFaults || checked) &&
      checked!.mounts !== undefined
    ) {
      const checkedMounts = shape(
        checked!.mounts,
        "invalid-bindings",
        "$.bindings.mounts",
        undefined,
        fault,
      );
      if (!collectConfigurationFaults || checkedMounts) {
        const validatedMounts = checkedMounts!;
        mounts = validatedMounts;
        const entries = Object.entries(validatedMounts);
        if (entries.length > 64) {
          reportConfigurationFault("binding-limit", "$.bindings.mounts", fault);
        }
        for (const [id, mount] of entries) {
          if (!NAME_PATTERN.test(id) || typeof mount !== "function") {
            reportConfigurationFault(
              "invalid-binding",
              `$.bindings.mounts.${id}`,
              fault,
            );
          }
        }
      }
    }
  }
  for (const [id, item] of Object.entries(content)) {
    for (const region of CONTENT_REGIONS) {
      const value = item[region];
      if (
        value &&
        typeof value !== "string" &&
        value.mountId &&
        !Object.hasOwn(mounts ?? {}, value.mountId)
      ) {
        reportConfigurationFault(
          "missing-binding",
          `$.content.${id}.${region}.mountId`,
          fault,
          value.mountId,
        );
      }
    }
  }
}

function validateTheme(
  theme: PeeklingOptions["theme"],
  fault: ConfigurationFaultSink,
): void {
  if (theme === undefined) return;
  const checked = shape(
    theme,
    "invalid-theme",
    "$.theme",
    [
      "background",
      "color",
      "linkColor",
      "borderColor",
      "radius",
      "width",
      "padding",
    ],
    fault,
  );
  if (collectConfigurationFaults && !checked) return;
  const validated = checked!;
  for (const [field, minimum, maximum] of [
    ["radius", 0, 64],
    ["width", 120, 640],
    ["padding", 0, 48],
  ] as const) {
    const value = validated[field];
    if (
      value !== undefined &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < minimum ||
        value > maximum)
    ) {
      reportConfigurationFault(
        "invalid-theme",
        `$.theme.${field}`,
        fault,
        field,
      );
    }
  }
  for (const field of [
    "background",
    "color",
    "linkColor",
    "borderColor",
  ] as const) {
    const value = validated[field];
    if (value !== undefined && !isSurfaceColor(value)) {
      reportConfigurationFault(
        "invalid-theme",
        `$.theme.${field}`,
        fault,
        field,
      );
    }
  }
}

function validateDiagnostics(
  diagnostics: PeeklingOptions["diagnostics"],
  fault: ConfigurationFaultSink,
): void {
  if (diagnostics === undefined) return;
  const checked = shape(
    diagnostics,
    "invalid-diagnostics",
    "$.diagnostics",
    ["console", "debug", "context"],
    fault,
  );
  if (collectConfigurationFaults && !checked) return;
  const validated = checked!;
  for (const field of ["console", "debug"] as const) {
    if (
      validated[field] !== undefined &&
      typeof validated[field] !== "boolean"
    ) {
      reportConfigurationFault(
        "invalid-diagnostics",
        `$.diagnostics.${field}`,
        fault,
        field,
      );
    }
  }
  const diagnosticContext = validated.context;
  if (diagnosticContext === undefined) return;
  const context = shape(
    diagnosticContext,
    "invalid-diagnostic-context",
    "$.diagnostics.context",
    undefined,
    fault,
  );
  if (collectConfigurationFaults && !context) return;
  const entries = Object.entries(context!);
  if (entries.length > 16) {
    reportConfigurationFault(
      "diagnostic-context-limit",
      "$.diagnostics.context",
      fault,
    );
  }
  for (const [key, value] of entries) {
    if (
      !/^[a-z][a-z0-9_.-]{0,31}$/.test(key) ||
      !["string", "number", "boolean"].includes(typeof value) ||
      (typeof value === "string" && value.length > 64) ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      reportConfigurationFault(
        "invalid-diagnostic-context",
        `$.diagnostics.context.${key}`,
        fault,
        key,
      );
    }
  }
}

function validateAccessibility(
  accessibility: PeeklingOptions["accessibility"],
  fault: ConfigurationFaultSink,
): void {
  if (accessibility === undefined) return;
  const checked = shape(
    accessibility,
    "invalid-accessibility",
    "$.accessibility",
    ["announceContent", "contentLabel"],
    fault,
  );
  if (collectConfigurationFaults && !checked) return;
  const validated = checked!;
  if (
    validated.announceContent !== undefined &&
    typeof validated.announceContent !== "boolean"
  ) {
    reportConfigurationFault(
      "invalid-accessibility",
      "$.accessibility.announceContent",
      fault,
      "announceContent",
    );
  }
  if (
    validated.contentLabel !== undefined &&
    !text(validated.contentLabel, 120)
  ) {
    reportConfigurationFault(
      "invalid-accessibility",
      "$.accessibility.contentLabel",
      fault,
      "contentLabel",
    );
  }
}

function shape(
  value: unknown,
  code: string,
  path: string,
  allowed: readonly string[] | undefined,
  fault: ConfigurationFaultSink,
): Record<string, unknown> | undefined {
  if (!record(value)) {
    reportConfigurationFault(code, path, fault);
    if (collectConfigurationFaults) return;
  }
  const checked = value as Record<string, unknown>;
  if (allowed) closed(checked, allowed, path, fault);
  return checked;
}

function closed(
  value: object,
  allowed: readonly string[],
  path: string,
  fault: ConfigurationFaultSink,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      reportConfigurationFault("unknown-field", `${path}.${key}`, fault);
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function reportConfigurationFault(
  code: string,
  path: string,
  fault: ConfigurationFaultSink,
  detail?: string,
): void {
  if (compactRuntimeDiagnostics) {
    throw new PeeklingPreflightError(code, path, code);
  }
  fault(code, path, detail);
}
