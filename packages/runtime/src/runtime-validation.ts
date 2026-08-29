import {
  PeeklingPreflightError,
  validateConfiguration,
} from "./configuration-validation.js";
import { compilePlan } from "./plan-compiler.js";
import { runtimeMessage } from "./runtime-diagnostics.js";
import type { PeeklingOptions } from "./runtime.js";
import { resolveStyleAsset, type RuntimeStyleAsset } from "./styles.js";
import type { HostContent } from "./types.js";

export {
  PeeklingPreflightError,
  type RuntimeConfigurationIssue,
  validRuntimeName,
} from "./configuration-validation.js";

export function validateRuntimeConfiguration(
  options: PeeklingOptions,
  baseUrl: string,
): readonly [HostContent, RuntimeStyleAsset] {
  const content = validateConfiguration(options, baseUrl, fail);
  let styles: RuntimeStyleAsset;
  try {
    styles = resolveStyleAsset(options.styles, baseUrl);
  } catch (cause) {
    fail(
      "invalid-styles",
      "$.styles",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (options.plan !== undefined) {
    try {
      compilePlan(options.plan, {
        contentIds: new Set(Object.keys(content)),
        targets: new Set(Object.keys(options.targets ?? {})),
      });
    } catch (cause) {
      fail(
        "invalid-plan",
        "$.plan",
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }
  return [content, styles];
}

function fail(code: string, path: string, detail?: string): never {
  throw new PeeklingPreflightError(
    code,
    path,
    runtimeMessage(code, () => configurationMessage(code, path, detail)),
  );
}

function configurationMessage(
  code: string,
  path: string,
  detail?: string,
): string {
  const field = path.slice(path.lastIndexOf(".") + 1);
  switch (code) {
    case "manifest.selection":
      return "Select an explicit character, packUrl, or pack";
    case "unknown-field":
      return `Unknown field ${detail ?? field}`;
    case "unsupported-format":
      return "Options format must be 1";
    case "invalid-character":
      return "character must be a bounded lowercase ID";
    case "character.unknown":
      return `Unknown Peekling character: ${detail ?? ""}`.trim();
    case "out-of-range":
      return "scale must be an integer from 1 to 4";
    case "invalid-density":
      return `${detail ?? field} must be 1, 2, or 4`;
    case "incompatible-density":
      return "density exceeds maxDensity";
    case "invalid-name":
      return "name must be true, false, or short plain text";
    case "invalid-url":
      return `${detail ?? field} must be a relative path or absolute HTTPS URL`;
    case "invalid-position":
      return "position must be a preset or bounded point with finite coordinates from -100000 through 100000";
    case "invalid-styles":
      return detail ?? "styles must be an object";
    case "invalid-styles-url":
      return "styles.url must be a relative path or absolute HTTPS URL";
    case "invalid-styles-integrity":
      return "styles.integrity must be one SRI hash";
    case "invalid-content":
      return detail ?? "content is invalid";
    case "invalid-bindings":
      return path === "$.bindings"
        ? "bindings must be an object"
        : `${detail ?? field} must be a registry object`;
    case "binding-limit":
      return `${detail ?? field} exceeds 64 entries`;
    case "invalid-binding":
      return "mount binding is invalid";
    case "missing-binding":
      return `Unknown mount binding ${detail ?? ""}`.trim();
    case "invalid-theme":
      if (path === "$.theme") return "theme must be an object";
      if (["background", "color", "linkColor", "borderColor"].includes(field)) {
        return `${field} must be transparent or a 3, 4, 6, or 8 digit hex color`;
      }
      return `${field} is outside its supported range`;
    case "invalid-diagnostics":
      return path === "$.diagnostics"
        ? "diagnostics must be an object"
        : `${detail ?? field} must be boolean`;
    case "invalid-diagnostic-context":
      return path === "$.diagnostics.context"
        ? "Diagnostic context must be an object"
        : "Diagnostic context needs bounded scalars";
    case "diagnostic-context-limit":
      return "Diagnostic context exceeds 16 fields";
    case "invalid-accessibility":
      if (path === "$.accessibility") {
        return "accessibility must be an object";
      }
      return field === "announceContent"
        ? "announceContent must be boolean"
        : "contentLabel must be short plain text";
    case "invalid-callback":
      return `${detail ?? field} must be a function`;
    case "invalid-plan":
      return detail ?? "Plan is invalid";
    case "incompatible-behavior":
      return "Choose preset or plan, not both";
    case "invalid-preset":
      return "preset must be companion, still, bottom-patrol, or viewport-roam";
    case "invalid-targets":
      return "targets must be an object of target IDs and CSS selectors";
    case "target-limit":
      return "targets supports at most 16 entries";
    case "invalid-target":
      return "target IDs must be bounded lowercase IDs";
    case "invalid-target-selector":
      return "target selectors must be bounded CSS selector text";
    case "invalid-interaction":
      return "interaction contains an unsupported value";
    case "invalid-interaction-event":
      return "interaction events must be bounded application Event names";
    case "missing-interaction-event":
      return "pressEvent is required when press is emit";
    case "incompatible-interaction-event":
      return "pressEvent can be used only with the emit press action";
    case "invalid-interaction-state":
      return "interaction states must be valid Pack State names";
    case "invalid-interaction-range":
      return "interaction physics value is outside its supported range";
    case "invalid-interaction-label":
      return "interaction label must be short plain text";
    case "invalid-catch-target":
      return "catchTarget must reference a configured target";
    case "invalid-catch-anchor":
      return "catchAnchor is not supported";
    case "invalid-indicator":
      return "indicator must include a label and valid dot or count settings";
    case "incompatible-indicator":
      return "indicator requires character interaction";
    default:
      return detail ?? code;
  }
}
