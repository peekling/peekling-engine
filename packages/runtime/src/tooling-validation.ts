export interface ToolingConfigurationDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly fix: string;
}

export function toolingDiagnostic(
  code: string,
  path: string,
  detail?: string,
): ToolingConfigurationDiagnostic {
  const field = path.slice(path.lastIndexOf(".") + 1);
  const diagnostic = (
    message: string,
    fix: string,
  ): ToolingConfigurationDiagnostic => ({
    code,
    path,
    message,
    fix,
  });
  switch (code) {
    case "manifest.selection":
      return diagnostic(
        "Select an explicit character, packUrl, or Pack",
        "Set character, packUrl, or pack",
      );
    case "unknown-field":
      return diagnostic(
        `Unknown field ${detail ?? field}`,
        "Remove this field",
      );
    case "unsupported-format":
      return diagnostic("Options format must be 1", "Use format 1");
    case "invalid-character":
      return diagnostic(
        "character must be a bounded lowercase ID",
        "Use a lowercase ID",
      );
    case "character.unknown":
      return diagnostic(
        `Unknown Peekling character: ${detail ?? ""}`.trim(),
        "Use a character included in the runtime registry",
      );
    case "out-of-range":
      return diagnostic(
        "scale must be an integer from 1 through 4",
        "Use 1 through 4",
      );
    case "invalid-density":
      return diagnostic(
        `${detail ?? field} must be 1, 2, or 4`,
        "Use 1, 2, or 4",
      );
    case "incompatible-density":
      return diagnostic(
        "density cannot exceed maxDensity",
        "Raise maxDensity or lower density",
      );
    case "atlas.max-density":
      return diagnostic(
        detail === "single"
          ? "Single atlas density exceeds maxDensity"
          : "No declared atlas variant is at or below maxDensity",
        detail === "single"
          ? "Raise maxDensity or use a lower-density Pack"
          : "Raise maxDensity or add a matching lower-density atlas variant",
      );
    case "atlas.override-density":
      return diagnostic(
        detail === "single"
          ? "density must match the single atlas density"
          : detail === "missing"
            ? "atlasUrl with variants requires an explicit density"
            : "atlasUrl density must name a declared variant at or below maxDensity",
        detail === "single"
          ? "Match the Pack atlas density or remove density"
          : "Set density to an available atlas variant",
      );
    case "invalid-name":
      return diagnostic(
        "name must be true, false, or short plain text",
        "Use true, false, or 1-80 plain characters",
      );
    case "invalid-url":
      return diagnostic(
        `${detail ?? field} must be a relative path or absolute HTTPS URL`,
        "Use a relative path or HTTPS URL",
      );
    case "invalid-position":
      return diagnostic(
        "position must be a preset or bounded point with finite coordinates from -100000 through 100000",
        "Use a preset or bounded x and y values",
      );
    case "invalid-styles":
      return diagnostic(
        detail ?? "styles must be an object",
        "Pass an external stylesheet URL and optional SRI hash",
      );
    case "invalid-styles-url":
      return diagnostic(
        "styles.url must be a relative path or absolute HTTPS URL",
        "Use a relative path or allowed pinned HTTPS URL",
      );
    case "invalid-styles-integrity":
      return diagnostic(
        "styles.integrity must be one SRI hash",
        "Use the release-provided stylesheet SRI value",
      );
    case "invalid-content":
      return diagnostic(
        detail ?? "content is invalid",
        "Fix the named content surface",
      );
    case "invalid-bindings":
      return diagnostic(
        path === "$.bindings"
          ? "bindings must be an object"
          : `${detail ?? field} must be a registry object`,
        "Pass a bounded mount registry",
      );
    case "binding-limit":
      return diagnostic(
        `${detail ?? field} exceeds 64 entries`,
        "Reduce the mount registry",
      );
    case "invalid-binding":
      return diagnostic(
        "Mount binding is invalid",
        "Use a bounded ID and function value",
      );
    case "missing-binding":
      return diagnostic(
        `Unknown mount binding ${detail ?? ""}`.trim(),
        "Register the mount binding",
      );
    case "invalid-theme":
      if (path === "$.theme") {
        return diagnostic("theme must be an object", "Pass theme tokens");
      }
      if (["background", "color", "linkColor", "borderColor"].includes(field)) {
        return diagnostic(
          `${field} must be transparent or a 3, 4, 6, or 8 digit hex color`,
          "Use transparent or a supported hex color",
        );
      }
      return diagnostic(
        `${field} is outside its supported range`,
        "Use the documented CSS pixel range",
      );
    case "invalid-diagnostics":
      return diagnostic(
        path === "$.diagnostics"
          ? "diagnostics must be an object"
          : `${detail ?? field} must be boolean`,
        "Pass bounded diagnostics options",
      );
    case "invalid-diagnostic-context":
      return diagnostic(
        path === "$.diagnostics.context"
          ? "Diagnostic context must be an object"
          : "Diagnostic context needs bounded scalars",
        "Use up to 16 bounded scalar fields",
      );
    case "diagnostic-context-limit":
      return diagnostic(
        "Diagnostic context exceeds 16 fields",
        "Keep up to 16 bounded fields",
      );
    case "invalid-accessibility":
      if (path === "$.accessibility") {
        return diagnostic(
          "accessibility must be an object",
          "Pass accessibility options",
        );
      }
      return field === "announceContent"
        ? diagnostic("announceContent must be boolean", "Use a boolean")
        : diagnostic(
            "contentLabel must be short plain text",
            "Use 1-120 plain characters",
          );
    case "invalid-callback":
      return diagnostic(
        `${detail ?? field} must be a function`,
        "Pass a JavaScript callback",
      );
    default:
      return diagnostic(detail ?? code, "Fix this field");
  }
}
