import { isNormalizedPack, validateNormalizedPack } from "./normalized.js";
import {
  OwnDataError,
  snapshotConfiguration,
  snapshotOwnData,
} from "./own-data.js";
import { validateNativePack } from "./pack.js";
import {
  preflight as configurationPreflight,
  type PreflightIssue,
} from "./preflight.js";
import type { PeeklingOptions } from "./runtime.js";
import { toolingDiagnostic } from "./tooling-validation.js";
import { NATIVE_DIRECTIONS, type NormalizedPack } from "./types.js";

export interface PreflightOptions {
  /** Optional Pack data used to validate Plan state and capability references. */
  readonly pack?: unknown;
  /** Base URL used only to resolve and validate relative resource URLs. */
  readonly baseUrl?: string;
}

export interface PreflightDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly fix: string;
}

export interface PreflightResult {
  readonly valid: boolean;
  readonly errors: readonly PreflightDiagnostic[];
  readonly warnings: readonly PreflightDiagnostic[];
}

/**
 * Inspect configuration and optional Pack data without executing project code,
 * predicates, callbacks, accessors, or network requests.
 */
export function preflight(
  configuration: unknown,
  options: PreflightOptions = {},
): PreflightResult {
  let checkedOptions: PreflightOptions;
  try {
    checkedOptions = snapshotOwnData(options) as PreflightOptions;
  } catch (cause) {
    return failedOptions(
      cause instanceof OwnDataError
        ? cause.message
        : "Preflight options cannot be inspected safely",
    );
  }
  if (
    !checkedOptions ||
    typeof checkedOptions !== "object" ||
    Array.isArray(checkedOptions)
  ) {
    return failedOptions("Preflight options must be an object");
  }

  const toolErrors: PreflightDiagnostic[] = [];
  for (const field of Object.keys(checkedOptions)) {
    if (field !== "pack" && field !== "baseUrl") {
      toolErrors.push({
        code: "unknown-preflight-option",
        path: `$options.${field}`,
        message: `Unknown preflight option ${field}`,
        fix: "Remove this field",
      });
    }
  }
  const validBaseUrl =
    checkedOptions.baseUrl === undefined ||
    (typeof checkedOptions.baseUrl === "string" &&
      absoluteHttpUrl(checkedOptions.baseUrl));
  if (!validBaseUrl) {
    toolErrors.push({
      code: "invalid-base-url",
      path: "$options.baseUrl",
      message: "baseUrl must be an absolute HTTP or HTTPS URL",
      fix: "Pass the intended deployment page URL",
    });
  }

  let snapshot: PeeklingOptions | undefined;
  let snapshotFailure: unknown;
  try {
    snapshot = snapshotConfiguration(configuration as PeeklingOptions);
  } catch (cause) {
    snapshotFailure = cause;
  }
  const externalPack = checkedOptions.pack;
  if (externalPack !== undefined && snapshot?.pack !== undefined) {
    toolErrors.push({
      code: "pack-context-conflict",
      path: "$options.pack",
      message: "Configuration already contains an inline Pack",
      fix: "Remove the external Pack option or the inline Configuration Pack",
    });
  }

  const packInput = snapshot?.pack ?? externalPack;
  let pack: NormalizedPack | undefined;
  let packError: PreflightDiagnostic | undefined;
  if (packInput !== undefined) {
    try {
      pack = isNormalizedPack(packInput)
        ? validateNormalizedPack(packInput)
        : validateNativePack(packInput);
    } catch (cause) {
      if (externalPack !== undefined && snapshot?.pack === undefined) {
        packError = {
          code: "invalid-pack",
          path: "$pack",
          message: diagnosticMessage(cause),
          fix: "Pass a valid data-only Pack",
        };
      }
    }
  }

  const checked = snapshot
    ? configurationPreflight(snapshot, {
        ...(validBaseUrl && typeof checkedOptions.baseUrl === "string"
          ? { baseUrl: checkedOptions.baseUrl }
          : {}),
        ...(externalPack !== undefined ? { externalPackSelection: true } : {}),
        ...(pack
          ? {
              states: new Set(Object.keys(pack.states)),
              capabilities: new Set<"locomotion">(
                pack.directionalStates &&
                  NATIVE_DIRECTIONS.every((direction) =>
                    Object.hasOwn(pack.directionalStates ?? {}, direction),
                  )
                  ? (["locomotion"] as const)
                  : [],
              ),
            }
          : {}),
      })
    : {
        valid: false,
        errors: [
          {
            code: "invalid-options",
            path: "$",
            message:
              snapshotFailure instanceof OwnDataError
                ? snapshotFailure.message
                : "Options cannot be inspected safely",
            fix: "Pass own data in a local ordinary object or null-prototype object",
          },
        ],
        warnings: [],
      };
  const errors: PreflightIssue[] = [
    ...toolErrors,
    ...(packError ? [packError] : []),
    ...checked.errors,
    ...(snapshot &&
    pack &&
    !checked.errors.some((issue) => issue.path === "$.atlasUrl")
      ? inspectAtlasDensityPolicy(snapshot, pack)
      : []),
  ];
  const warnings: PreflightIssue[] = [...checked.warnings];
  if (snapshot?.plan && packInput === undefined) {
    warnings.push({
      code: "pack-context-missing",
      path: "$.plan",
      message: "Plan references cannot be checked without Pack context",
      fix: "Pass the Pack with the preflight options or peekling doctor --pack",
    });
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function inspectAtlasDensityPolicy(
  options: PeeklingOptions,
  pack: NormalizedPack,
): readonly PreflightDiagnostic[] {
  const variants = pack.atlas.variants;
  if (!validDensity(options.maxDensity ?? 4)) {
    return [];
  }

  const maxDensity = options.maxDensity ?? 4;
  if (!variants?.length) {
    const density = pack.atlas.density ?? 1;
    const issues: PreflightDiagnostic[] = [];
    if (
      options.density !== undefined &&
      validDensity(options.density) &&
      options.density !== density
    ) {
      issues.push(
        toolingDiagnostic("atlas.override-density", "$.density", "single"),
      );
    }
    if (density > maxDensity) {
      issues.push(
        toolingDiagnostic("atlas.max-density", "$.maxDensity", "single"),
      );
    }
    return issues;
  }
  if (typeof options.atlasUrl !== "string") return [];

  const available = variants.filter((item) => item.density <= maxDensity);
  if (!available.length) {
    return [toolingDiagnostic("atlas.max-density", "$.maxDensity")];
  }

  if (options.density === undefined) {
    return [
      toolingDiagnostic("atlas.override-density", "$.density", "missing"),
    ];
  }
  if (
    !validDensity(options.density) ||
    options.density > maxDensity ||
    available.some((item) => item.density === options.density)
  ) {
    return [];
  }
  return [toolingDiagnostic("atlas.override-density", "$.density")];
}

function validDensity(value: unknown): value is 1 | 2 | 4 {
  return value === 1 || value === 2 || value === 4;
}

function failedOptions(message: string): PreflightResult {
  return {
    valid: false,
    errors: [
      {
        code: "invalid-preflight-options",
        path: "$options",
        message,
        fix: "Pass an optional Pack and baseUrl in an object",
      },
    ],
    warnings: [],
  };
}

function diagnosticMessage(cause: unknown): string {
  if (!(cause instanceof Error)) return "Pack could not be inspected safely";
  return cause.message.replace(/^Pack validation failed:\s*/u, "").trim();
}

function absoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
