import { validateConfiguration } from "./configuration-validation.js";
import { isNormalizedPack, validateNormalizedPack } from "./normalized.js";
import { OwnDataError, snapshotConfiguration } from "./own-data.js";
import { validateNativePack } from "./pack.js";
import { preflightPlan } from "./plan-compiler.js";
import type { PeeklingOptions } from "./runtime.js";
import { toolingDiagnostic } from "./tooling-validation.js";
import { CONTENT_REGIONS } from "./types.js";

const REMOVED_FIELDS = new Set(["run", "constructor", "behaviors"]);

export interface PreflightIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly fix: string;
}

export interface PreflightResult {
  readonly valid: boolean;
  readonly errors: readonly PreflightIssue[];
  readonly warnings: readonly PreflightIssue[];
}

export interface PreflightContext {
  readonly document?: Document;
  readonly baseUrl?: string;
  readonly states?: ReadonlySet<string>;
  readonly capabilities?: ReadonlySet<"locomotion">;
  /** Package-internal context for an externally supplied, validated Pack. */
  readonly externalPackSelection?: boolean;
}

export function preflight(
  input: PeeklingOptions,
  context: PreflightContext = {},
): PreflightResult {
  const errors: PreflightIssue[] = [];
  const warnings: PreflightIssue[] = [];
  let options: PeeklingOptions;
  try {
    options = snapshotConfiguration(input);
  } catch (cause) {
    errors.push({
      code: "invalid-options",
      path: "$",
      message:
        cause instanceof OwnDataError
          ? cause.message
          : "Options cannot be inspected safely",
      fix: "Pass own data in a local ordinary object or null-prototype object",
    });
    return { valid: false, errors, warnings };
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    errors.push({
      code: "invalid-options",
      path: "$",
      message: "Options must be an object",
      fix: "Pass own data in a local ordinary object or null-prototype object",
    });
    return { valid: false, errors, warnings };
  }

  for (const field of REMOVED_FIELDS) {
    if (!Object.hasOwn(options, field)) continue;
    const guidance = removedFieldDiagnostic(field);
    errors.push({
      code: "removed-api",
      path: `$.${field}`,
      message: guidance.message,
      fix: guidance.fix,
    });
  }

  if (options.pack !== undefined) {
    try {
      if (isNormalizedPack(options.pack)) validateNormalizedPack(options.pack);
      else validateNativePack(options.pack);
    } catch (cause) {
      errors.push({
        code: "invalid-pack",
        path: "$.pack",
        message: String(cause),
        fix: "Pass a valid data-only Pack",
      });
    }
  }

  const reportFault = (code: string, path: string, detail?: string) => {
    if (context.externalPackSelection && code === "manifest.selection") return;
    errors.push(toolingDiagnostic(code, path, detail));
  };
  const checkedOptions = { ...options } as PeeklingOptions &
    Record<string, unknown>;
  for (const field of REMOVED_FIELDS)
    Reflect.deleteProperty(checkedOptions, field);
  const content = validateConfiguration(
    checkedOptions,
    context.baseUrl ?? "https://peekling.invalid/",
    reportFault,
  );

  if (options.plan !== undefined) {
    const checkedPlan = preflightPlan(options.plan, {
      ...(context.states ? { states: context.states } : {}),
      ...(context.capabilities ? { capabilities: context.capabilities } : {}),
      contentIds: new Set(Object.keys(content)),
    });
    for (const issue of checkedPlan.errors) {
      errors.push({
        code: issue.code,
        path: issue.path.replace(/^\$plan/, "$.plan"),
        message: issue.message,
        fix: "Fix the Plan field and referenced Pack or content ID",
      });
    }
    inspectSelectors(options, context.document, errors, warnings);
  }

  for (const field of ["onDiagnostic", "logger"] as const) {
    if (typeof options[field] === "function") {
      warnings.push({
        code: "unverified-callback",
        path: `$.${field}`,
        message: "Preflight cannot prove callback behavior",
        fix: "Keep callback side effects bounded",
      });
    }
  }
  for (const [id, item] of Object.entries(content)) {
    for (const region of CONTENT_REGIONS) {
      const surface = item[region];
      if (surface && typeof surface !== "string" && surface.mountId) {
        warnings.push({
          code: "unverified-host-code",
          path: `$.content.${id}.${region}`,
          message: "Preflight cannot prove host code safe",
          fix: "Keep host code bounded",
        });
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function inspectSelectors(
  options: PeeklingOptions,
  document: Document | undefined,
  errors: PreflightIssue[],
  warnings: PreflightIssue[],
): void {
  if (!document || !options.plan || !Array.isArray(options.plan.rules)) return;
  for (const [index, rule] of options.plan.rules.entries()) {
    const when = rule?.when;
    if (
      !when ||
      when.source !== "browser" ||
      when.event !== "section.visibility" ||
      typeof when.selector !== "string"
    ) {
      continue;
    }
    const path = `$.plan.rules[${index}].when.selector`;
    try {
      if (!document.querySelector(when.selector)) {
        warnings.push({
          code: "missing-selector",
          path,
          message: `No element currently matches ${when.selector}`,
          fix: "Ensure the element exists",
        });
      }
    } catch {
      errors.push({
        code: "invalid-selector",
        path,
        message: `Invalid selector ${when.selector}`,
        fix: "Use a valid bounded CSS selector",
      });
    }
  }
}

function removedFieldDiagnostic(field: string): {
  readonly message: string;
  readonly fix: string;
} {
  if (field === "behaviors") {
    return {
      message: "behaviors is not a Peekling 0.1 configuration field",
      fix: "Express the behavior as Rules in one canonical Plan",
    };
  }
  return {
    message:
      field === "run"
        ? "run is not part of the Peekling 0.1 API"
        : "Direct construction is not part of the Peekling 0.1 API",
    fix: "Create the instance with hatch(configuration)",
  };
}
