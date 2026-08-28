import { addPackIssue, packIssue, PackValidationError } from "./errors.js";
import { validateEventPayload } from "./events.js";
import { selectNativeDensity } from "./pack.js";
import {
  ASSET_PATH_PATTERN,
  NAME_PATTERN,
  SEMVER_PATTERN,
  SPDX_LICENSE_PATTERN,
} from "./contracts.js";
import {
  closed,
  record as object,
  validateDensityVariants,
  validateMotionKeyframes,
  validateSha256,
  validateStateMap,
} from "./pack-shared.js";
import {
  NATIVE_DIRECTIONS,
  type AtlasGeometry,
  type Direction,
  type NormalizedPack,
} from "./types.js";
import { OwnDataError, snapshotPackData } from "./own-data.js";
import { runtimeMessage } from "./runtime-diagnostics.js";

const MAX_NORMALIZED_ATLAS_BYTES = 32 * 1024 * 1024;

function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function isNormalizedPack(input: unknown): input is NormalizedPack {
  if (!object(input)) return false;
  const atlas = Object.getOwnPropertyDescriptor(input, "atlas")?.value;
  const assets = Object.getOwnPropertyDescriptor(input, "assets")?.value;
  return object(atlas) && !object(assets);
}

export function validateNormalizedPack(
  input: unknown,
  geometry?: AtlasGeometry,
  preferredDensity?: number,
): NormalizedPack {
  const issues: string[] = [];
  try {
    input = snapshotPackData(input);
  } catch (cause) {
    if (cause instanceof OwnDataError) {
      throw new PackValidationError(
        [cause.message],
        cause.issueCode ? [cause.issueCode] : [],
      );
    }
    throw cause;
  }
  if (!object(input) || !object(input.atlas) || !object(input.states)) {
    throw new PackValidationError([
      packIssue(
        "normalized.structure",
        "normalized pack needs atlas and states",
      ),
    ]);
  }
  closed(
    input,
    [
      "name",
      "displayName",
      "version",
      "license",
      "atlas",
      "states",
      "defaultScale",
      "directionalStates",
      "locomotionMotion",
      "reactionStates",
      "source",
    ],
    "normalizedPack",
    issues,
  );
  for (const field of ["name", "version", "license"] as const) {
    if (!text(input[field]))
      addPackIssue(
        issues,
        `normalized.${field}`,
        `${field} must be a short safe string`,
      );
  }
  if (!text(input.displayName) || input.displayName.length > 120)
    addPackIssue(
      issues,
      "normalized.displayName",
      "displayName must be 1-120 characters",
    );
  else if (/:\/\//.test(input.displayName))
    addPackIssue(
      issues,
      "normalized.displayName",
      "displayName must not contain a URL",
    );
  if (typeof input.version === "string" && input.version.length > 64)
    addPackIssue(
      issues,
      "normalized.version",
      "version must be at most 64 characters",
    );
  if (text(input.name) && !NAME_PATTERN.test(input.name))
    addPackIssue(issues, "normalized.name", "name must be a lowercase ID");
  if (text(input.version) && !SEMVER_PATTERN.test(input.version))
    addPackIssue(issues, "normalized.version", "version must be SemVer 2.0");
  if (text(input.license) && !SPDX_LICENSE_PATTERN.test(input.license))
    addPackIssue(
      issues,
      "normalized.license",
      "license must be SPDX or LicenseRef",
    );
  const atlas = input.atlas;
  closed(
    atlas,
    [
      "src",
      "columns",
      "rows",
      "cellWidth",
      "cellHeight",
      "logicalWidth",
      "logicalHeight",
      "density",
      "lineage",
      "sha256",
      "variants",
    ],
    "atlas",
    issues,
  );
  const dimensions = [
    ["columns", 256],
    ["rows", 4_096],
    ["cellWidth", 1_024],
    ["cellHeight", 1_024],
  ] as const;
  for (const [field, maximum] of dimensions) {
    if (
      !Number.isInteger(atlas[field]) ||
      (atlas[field] as number) < 1 ||
      (atlas[field] as number) > maximum
    ) {
      addPackIssue(
        issues,
        `atlas.${field}`,
        `atlas.${field} must be integer 1-${maximum}`,
      );
    }
  }
  if (
    !text(atlas.src) ||
    !ASSET_PATH_PATTERN.test(atlas.src) ||
    !/\.(?:png|webp)$/i.test(atlas.src)
  ) {
    addPackIssue(
      issues,
      "atlas.src",
      "atlas.src must be a safe relative PNG or WebP path",
    );
  }
  const columns = Number(atlas.columns);
  const rows = Number(atlas.rows);
  const cellWidth = Number(atlas.cellWidth);
  const cellHeight = Number(atlas.cellHeight);
  for (const field of ["logicalWidth", "logicalHeight"] as const) {
    if (
      atlas[field] !== undefined &&
      (!Number.isInteger(atlas[field]) ||
        (atlas[field] as number) < 1 ||
        (atlas[field] as number) > 256)
    )
      addPackIssue(
        issues,
        `atlas.${field}`,
        `atlas.${field} must be integer 1-256`,
      );
  }
  if (
    atlas.density !== undefined &&
    !([1, 2, 4] as unknown[]).includes(atlas.density)
  )
    addPackIssue(issues, "atlas.density", "atlas.density must be 1, 2, or 4");
  if (
    atlas.lineage !== undefined &&
    (!text(atlas.lineage) ||
      !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(atlas.lineage))
  )
    addPackIssue(issues, "atlas.lineage", "atlas.lineage must be a safe ID");
  const variants =
    atlas.variants === undefined
      ? []
      : validateDensityVariants(
          atlas.variants,
          { path: "atlas.variants" },
          issues,
        );
  const baseSha256 =
    atlas.sha256 === undefined
      ? undefined
      : validateSha256(atlas.sha256, "atlas.sha256", issues)
        ? atlas.sha256
        : undefined;
  if (atlas.variants === undefined && atlas.sha256 === undefined) {
    validateSha256(undefined, "atlas.sha256", issues);
  }
  const baseDensity = ([1, 2, 4] as unknown[]).includes(atlas.density)
    ? (atlas.density as 1 | 2 | 4)
    : 1;
  const logicalWidth = Number.isInteger(atlas.logicalWidth)
    ? (atlas.logicalWidth as number)
    : cellWidth / baseDensity;
  const logicalHeight = Number.isInteger(atlas.logicalHeight)
    ? (atlas.logicalHeight as number)
    : cellHeight / baseDensity;
  const selectedDensity = variants.length
    ? selectNativeDensity(
        variants.map((item) => item.density),
        preferredDensity ?? baseDensity,
      )
    : baseDensity;
  const selectedVariant = variants.find(
    (item) => item.density === selectedDensity,
  );
  const selectedSha256 = selectedVariant?.sha256 ?? baseSha256;
  const selectedSrc = selectedVariant?.src ?? (atlas.src as string);
  const selectedCellWidth = selectedVariant?.cellWidth ?? cellWidth;
  const selectedCellHeight = selectedVariant?.cellHeight ?? cellHeight;
  if (
    !Number.isInteger(logicalWidth) ||
    !Number.isInteger(logicalHeight) ||
    selectedCellWidth !== logicalWidth * selectedDensity ||
    selectedCellHeight !== logicalHeight * selectedDensity
  ) {
    addPackIssue(
      issues,
      "atlas.logical-cell",
      "atlas candidates must preserve integer logical cells",
    );
  }
  const cellCount = columns * rows;
  if (columns * selectedCellWidth > 4096 || rows * selectedCellHeight > 4096) {
    addPackIssue(issues, "atlas.size", "normalized atlas exceeds 4096x4096");
  }
  const states = validateStateMap(input.states, cellCount, issues);
  if (
    !Number.isInteger(input.defaultScale) ||
    (input.defaultScale as number) < 1 ||
    (input.defaultScale as number) > 4
  ) {
    addPackIssue(
      issues,
      "normalized.defaultScale",
      "defaultScale must be integer 1-4",
    );
  }
  const directionalStates: Partial<Record<Direction, string>> = {};
  if (input.directionalStates !== undefined) {
    if (!object(input.directionalStates))
      addPackIssue(
        issues,
        "directionalStates",
        "directionalStates must be an object",
      );
    else {
      closed(
        input.directionalStates,
        NATIVE_DIRECTIONS,
        "directionalStates",
        issues,
      );
      for (const direction of NATIVE_DIRECTIONS) {
        const target = input.directionalStates[direction];
        if (target !== undefined) {
          if (typeof target !== "string" || !states[target]) {
            addPackIssue(
              issues,
              `directionalStates.${direction}`,
              `directionalStates.${direction} must name a state`,
            );
          } else directionalStates[direction] = target;
        }
      }
    }
  }
  const reactionStates: Record<string, string> = {};
  if (input.reactionStates !== undefined) {
    if (
      !object(input.reactionStates) ||
      Object.keys(input.reactionStates).length > 32
    ) {
      addPackIssue(
        issues,
        "reactionStates.limit",
        "reactionStates allows up to 32 mappings",
      );
    } else {
      for (const [semantic, target] of Object.entries(input.reactionStates)) {
        if (
          !/^[a-z][a-z0-9-]{0,63}$/.test(semantic) ||
          typeof target !== "string" ||
          !states[target]
        ) {
          addPackIssue(
            issues,
            `reactionStates.${semantic}`,
            `reactionStates.${semantic} must name a state`,
          );
        } else reactionStates[semantic] = target;
      }
    }
  }
  let locomotionMotion: Array<{
    at: number;
    advance: number;
    lift: number;
  }> = [];
  if (input.locomotionMotion !== undefined) {
    locomotionMotion = validateMotionKeyframes(
      input.locomotionMotion,
      "locomotionMotion",
      issues,
    );
  }
  if (
    geometry &&
    (geometry.width !== columns * selectedCellWidth ||
      geometry.height !== rows * selectedCellHeight)
  ) {
    addPackIssue(
      issues,
      "atlas.pixels",
      `atlas pixels must match ${columns * selectedCellWidth}x${rows * selectedCellHeight}`,
    );
  }
  if (
    geometry?.byteLength !== undefined &&
    (!Number.isSafeInteger(geometry.byteLength) ||
      geometry.byteLength < 1 ||
      geometry.byteLength > MAX_NORMALIZED_ATLAS_BYTES)
  ) {
    addPackIssue(
      issues,
      "atlas.size",
      "normalized atlas exceeds resource limits",
    );
  }
  let source:
    Readonly<Record<string, import("./types.js").JsonValue>> | undefined;
  if (input.source !== undefined) {
    try {
      const checked = validateEventPayload(input.source);
      if (!object(checked))
        throw new TypeError(
          runtimeMessage("normalized.source", "source must be a JSON object"),
        );
      source = Object.freeze({ ...checked });
    } catch (cause) {
      addPackIssue(
        issues,
        "normalized.source",
        `source must be bounded JSON: ${String(cause)}`,
      );
    }
  }
  if (issues.length || !selectedSha256) {
    throw new PackValidationError(
      issues.length
        ? issues
        : [
            packIssue(
              "atlas.sha256",
              "atlas.sha256 must be 64 lowercase hexadecimal characters",
            ),
          ],
    );
  }
  return {
    name: input.name as string,
    displayName: text(input.displayName)
      ? (input.displayName as string)
      : (input.name as string),
    version: input.version as string,
    license: input.license as string,
    atlas: {
      src: selectedSrc,
      sha256: selectedSha256,
      columns,
      rows,
      cellWidth: selectedCellWidth,
      cellHeight: selectedCellHeight,
      logicalWidth,
      logicalHeight,
      density: selectedDensity,
      ...(typeof atlas.lineage === "string" ? { lineage: atlas.lineage } : {}),
      ...(variants.length ? { variants } : {}),
    },
    states,
    defaultScale: input.defaultScale as number,
    ...(Object.keys(directionalStates).length ? { directionalStates } : {}),
    ...(locomotionMotion.length ? { locomotionMotion } : {}),
    ...(Object.keys(reactionStates).length ? { reactionStates } : {}),
    ...(source ? { source } : {}),
  };
}

export function resolveCapabilityName(
  requested: string | undefined,
  pack: NormalizedPack,
): string | undefined {
  if (!requested) return undefined;
  return pack.reactionStates && Object.hasOwn(pack.reactionStates, requested)
    ? pack.reactionStates[requested]
    : requested;
}
