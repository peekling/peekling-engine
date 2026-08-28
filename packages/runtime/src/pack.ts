import { addPackIssue, packIssue, PackValidationError } from "./errors.js";
import { DEFAULT_NATIVE_SCALE } from "./defaults.js";
import { parseDataText } from "./json.js";
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
  NATIVE_CELL_SIZE,
  NATIVE_COLUMNS,
  NATIVE_DENSITIES,
  NATIVE_DIRECTIONS,
  NATIVE_LOGICAL_SIZES,
  type AtlasGeometry,
  type NativeManifest,
  type NormalizedPack,
} from "./types.js";
import { OwnDataError, snapshotPackData } from "./own-data.js";

const MAX_ATLAS_BYTES = 4 * 1024 * 1024;
export const MAX_ATLAS_SIDE = 4096;
const MAX_STRING = 256;
const METADATA_TAG_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

function safeString(
  value: unknown,
  field: string,
  issues: string[],
  maximum = MAX_STRING,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    addPackIssue(issues, field, `${field} must be 1-${maximum} characters`);
    return undefined;
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    addPackIssue(issues, field, `${field} contains control characters`);
    return undefined;
  }
  return value;
}

export function parseManifestText(text: string): unknown {
  return parseDataText(text, "character.json");
}

export function validateNativePack(
  input: unknown,
  geometry?: AtlasGeometry,
  preferredDensity = 1,
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
  if (!object(input))
    throw new PackValidationError([
      packIssue("manifest", "manifest must be an object"),
    ]);

  closed(
    input,
    [
      "format",
      "name",
      "version",
      "license",
      "metadata",
      "assets",
      "states",
      "capabilities",
      "defaults",
    ],
    "manifest",
    issues,
  );

  if (input.format !== 1)
    addPackIssue(issues, "format", "format must be the integer 1");
  const name = safeString(input.name, "name", issues, 64);
  if (name && !NAME_PATTERN.test(name))
    addPackIssue(issues, "name", "name must be a lowercase ID");
  const version = safeString(input.version, "version", issues, 64);
  const license = safeString(input.license, "license", issues, 128);
  if (version && !SEMVER_PATTERN.test(version))
    addPackIssue(issues, "version", "version must be SemVer 2.0");
  if (license && !SPDX_LICENSE_PATTERN.test(license))
    addPackIssue(issues, "license", "license must be SPDX or LicenseRef");

  let atlasSrc: string | undefined;
  let atlasSha256: string | undefined;
  let rows = 0;
  let density = 1;
  let logicalCellSize = NATIVE_CELL_SIZE;
  let sourceCellSize = NATIVE_CELL_SIZE;
  let lineage: string | undefined;
  let variants:
    | Array<{
        src: string;
        density: 1 | 2 | 4;
        cellWidth: number;
        cellHeight: number;
        sha256: string;
      }>
    | undefined;
  if (!object(input.assets)) {
    addPackIssue(issues, "assets", "assets must describe an atlas or variants");
  } else if (object(input.assets.atlas)) {
    closed(input.assets, ["atlas"], "assets", issues);
    const atlas = input.assets.atlas;
    closed(
      atlas,
      [
        "src",
        "columns",
        "rows",
        "density",
        "logicalCellSize",
        "sourceCellSize",
        "sha256",
      ],
      "assets.atlas",
      issues,
    );
    atlasSrc = safeString(atlas.src, "assets.atlas.src", issues);
    if (validateSha256(atlas.sha256, "assets.atlas.sha256", issues)) {
      atlasSha256 = atlas.sha256;
    }
    if (
      atlasSrc &&
      (!ASSET_PATH_PATTERN.test(atlasSrc) || !/\.png$/i.test(atlasSrc))
    ) {
      addPackIssue(
        issues,
        "assets.atlas.src",
        "assets.atlas.src must be a relative in-pack PNG path",
      );
    }
    if (atlas.columns !== NATIVE_COLUMNS) {
      addPackIssue(
        issues,
        "assets.atlas.columns",
        `assets.atlas.columns must be ${NATIVE_COLUMNS}`,
      );
    }
    const densityFields = [
      atlas.density,
      atlas.logicalCellSize,
      atlas.sourceCellSize,
    ];
    const hasDensityFields = densityFields.some((value) => value !== undefined);
    const hasAllDensityFields = densityFields.every(
      (value) => value !== undefined,
    );
    if (hasDensityFields && !hasAllDensityFields) {
      addPackIssue(
        issues,
        "assets.atlas.density",
        "assets.atlas density and sizes must appear together",
      );
    }
    if (hasAllDensityFields) {
      if (
        !NATIVE_DENSITIES.includes(
          atlas.density as (typeof NATIVE_DENSITIES)[number],
        )
      ) {
        addPackIssue(
          issues,
          "assets.atlas.density",
          "assets.atlas.density must be 1, 2, or 4",
        );
      } else {
        density = atlas.density as number;
      }
      if (
        !NATIVE_LOGICAL_SIZES.includes(
          atlas.logicalCellSize as (typeof NATIVE_LOGICAL_SIZES)[number],
        )
      ) {
        addPackIssue(
          issues,
          "assets.atlas.logicalCellSize",
          "assets.atlas.logicalCellSize must be 32 or 64",
        );
      } else {
        logicalCellSize = atlas.logicalCellSize as number;
      }
      if (
        !Number.isInteger(atlas.sourceCellSize) ||
        atlas.sourceCellSize !== logicalCellSize * density
      ) {
        addPackIssue(
          issues,
          "assets.atlas.sourceCellSize",
          "assets.atlas.sourceCellSize must equal logical size * density",
        );
      } else {
        sourceCellSize = atlas.sourceCellSize as number;
      }
    }
    if (
      !Number.isInteger(atlas.rows) ||
      (atlas.rows as number) < 2 ||
      (atlas.rows as number) > MAX_ATLAS_SIDE / sourceCellSize
    ) {
      addPackIssue(
        issues,
        "assets.atlas.rows",
        `assets.atlas.rows exceeds ${MAX_ATLAS_SIDE}px at density ${density}`,
      );
    } else {
      rows = atlas.rows as number;
    }
  } else if (object(input.assets.atlases)) {
    closed(input.assets, ["atlases"], "assets", issues);
    const set = input.assets.atlases;
    closed(
      set,
      ["columns", "rows", "logicalCellSize", "lineage", "variants"],
      "assets.atlases",
      issues,
    );
    if (set.columns !== NATIVE_COLUMNS)
      addPackIssue(
        issues,
        "assets.atlases.columns",
        `assets.atlases.columns must be ${NATIVE_COLUMNS}`,
      );
    if (
      !NATIVE_LOGICAL_SIZES.includes(
        set.logicalCellSize as (typeof NATIVE_LOGICAL_SIZES)[number],
      )
    ) {
      addPackIssue(
        issues,
        "assets.atlases.logicalCellSize",
        "assets.atlases.logicalCellSize must be 32 or 64",
      );
    } else logicalCellSize = set.logicalCellSize as number;
    lineage = safeString(set.lineage, "assets.atlases.lineage", issues, 128);
    if (!lineage || !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(lineage))
      addPackIssue(
        issues,
        "assets.atlases.lineage",
        "assets.atlases.lineage must be a safe ID",
      );
    variants = validateDensityVariants(
      set.variants,
      {
        path: "assets.atlases.variants",
        logicalWidth: logicalCellSize,
        logicalHeight: logicalCellSize,
        native: true,
      },
      issues,
    );
    const chosen = variants.length
      ? selectNativeDensity(
          variants.map((item) => item.density),
          preferredDensity,
        )
      : undefined;
    const selected = variants.find((item) => item.density === chosen);
    if (selected) {
      atlasSrc = selected.src;
      atlasSha256 = selected.sha256;
      density = selected.density;
      sourceCellSize = selected.cellWidth;
    }
    if (
      !Number.isInteger(set.rows) ||
      (set.rows as number) < 2 ||
      (set.rows as number) > MAX_ATLAS_SIDE / sourceCellSize
    )
      addPackIssue(
        issues,
        "assets.atlases.rows",
        `assets.atlases.rows exceeds ${MAX_ATLAS_SIDE}px`,
      );
    else rows = set.rows as number;
  } else {
    addPackIssue(issues, "assets", "assets must contain atlas or atlases");
  }

  const states = validateStateMap(input.states, rows * NATIVE_COLUMNS, issues);
  const directionalStates: Record<string, string> = Object.create(
    null,
  ) as Record<string, string>;
  let locomotionMotion:
    Array<{ at: number; advance: number; lift: number }> | undefined;
  if (input.capabilities !== undefined) {
    if (object(input.capabilities))
      closed(input.capabilities, ["locomotion"], "capabilities", issues);
    const locomotion = object(input.capabilities)
      ? input.capabilities.locomotion
      : undefined;
    if (!object(locomotion) || !object(locomotion.directions)) {
      addPackIssue(
        issues,
        "capabilities.locomotion.directions",
        "locomotion.directions must be an object",
      );
    } else {
      closed(
        locomotion,
        ["directions", "motion"],
        "capabilities.locomotion",
        issues,
      );
      closed(
        locomotion.directions,
        NATIVE_DIRECTIONS,
        "capabilities.locomotion.directions",
        issues,
      );
      for (const direction of NATIVE_DIRECTIONS) {
        const target = locomotion.directions[direction];
        if (typeof target !== "string" || !states[target])
          addPackIssue(
            issues,
            `capabilities.locomotion.directions.${direction}`,
            `capabilities.locomotion.directions.${direction} must name a valid state`,
          );
        else directionalStates[direction] = target;
      }
      if (locomotion.motion !== undefined) {
        const keyframes = object(locomotion.motion)
          ? locomotion.motion.keyframes
          : undefined;
        if (object(locomotion.motion)) {
          closed(
            locomotion.motion as Record<string, unknown>,
            ["keyframes"],
            "capabilities.locomotion.motion",
            issues,
          );
        }
        const parsed = validateMotionKeyframes(
          keyframes,
          "capabilities.locomotion.motion.keyframes",
          issues,
        );
        if (Array.isArray(keyframes) && parsed.length === keyframes.length)
          locomotionMotion = parsed;
      }
    }
  }

  let scale: number = DEFAULT_NATIVE_SCALE;
  if (input.defaults !== undefined) {
    if (!object(input.defaults)) {
      addPackIssue(issues, "defaults", "defaults must be an object");
    } else {
      closed(input.defaults, ["scale"], "defaults", issues);
      if (input.defaults.scale !== undefined) {
        if (
          !Number.isInteger(input.defaults.scale) ||
          (input.defaults.scale as number) < 1 ||
          (input.defaults.scale as number) > 4
        ) {
          addPackIssue(
            issues,
            "defaults.scale",
            "defaults.scale must be an integer from 1 through 4",
          );
        } else {
          scale = input.defaults.scale as number;
        }
      }
    }
  }

  if (!object(input.metadata)) {
    addPackIssue(
      issues,
      "metadata",
      "metadata must be an object with a description",
    );
  } else {
    closed(
      input.metadata,
      ["title", "author", "description", "tags"],
      "metadata",
      issues,
    );
    safeString(input.metadata.description, "metadata.description", issues, 500);
    if (
      typeof input.metadata.description === "string" &&
      /:\/\//.test(input.metadata.description)
    ) {
      addPackIssue(
        issues,
        "metadata.description",
        "metadata.description must not contain a URL",
      );
    }
    for (const key of ["title", "author"] as const) {
      if (input.metadata[key] !== undefined) {
        safeString(input.metadata[key], `metadata.${key}`, issues, 120);
        if (
          typeof input.metadata[key] === "string" &&
          /:\/\//.test(input.metadata[key])
        ) {
          addPackIssue(
            issues,
            `metadata.${key}`,
            `metadata.${key} must not contain a URL`,
          );
        }
      }
    }
    if (
      input.metadata.tags !== undefined &&
      (!Array.isArray(input.metadata.tags) ||
        input.metadata.tags.length > 16 ||
        input.metadata.tags.some(
          (tag) => typeof tag !== "string" || !METADATA_TAG_PATTERN.test(tag),
        ))
    ) {
      addPackIssue(
        issues,
        "metadata.tags",
        "metadata.tags allows 16 lowercase IDs",
      );
    }
  }

  if (geometry) {
    const expectedWidth = NATIVE_COLUMNS * sourceCellSize;
    const expectedHeight = rows * sourceCellSize;
    if (
      geometry.width !== expectedWidth ||
      geometry.height !== expectedHeight
    ) {
      addPackIssue(
        issues,
        "atlas.dimensions",
        `atlas must be exactly ${expectedWidth}x${expectedHeight}`,
      );
    }
    if (
      geometry.width > MAX_ATLAS_SIDE ||
      geometry.height > MAX_ATLAS_SIDE ||
      (geometry.byteLength !== undefined &&
        geometry.byteLength > MAX_ATLAS_BYTES)
    ) {
      addPackIssue(
        issues,
        "atlas.size",
        "atlas exceeds native resource limits",
      );
    }
  }

  if (
    issues.length ||
    !name ||
    !version ||
    !license ||
    !atlasSrc ||
    !atlasSha256
  ) {
    throw new PackValidationError(
      issues.length
        ? issues
        : [packIssue("manifest.incomplete", "manifest is incomplete")],
    );
  }

  const manifest = input as unknown as NativeManifest;
  return {
    name,
    displayName: manifest.metadata.title ?? name,
    version,
    license,
    atlas: {
      src: atlasSrc,
      sha256: atlasSha256,
      columns: NATIVE_COLUMNS,
      rows,
      cellWidth: sourceCellSize,
      cellHeight: sourceCellSize,
      logicalWidth: logicalCellSize,
      logicalHeight: logicalCellSize,
      density: density as 1 | 2 | 4,
      ...(lineage ? { lineage } : {}),
      ...(variants ? { variants } : {}),
    },
    states,
    defaultScale: scale,
    ...(Object.keys(directionalStates).length ? { directionalStates } : {}),
    ...(locomotionMotion ? { locomotionMotion } : {}),
    ...(manifest.metadata ? { source: { metadata: manifest.metadata } } : {}),
  };
}

export function selectNativeDensity(
  available: readonly (1 | 2 | 4)[],
  required: number,
): 1 | 2 | 4 {
  const sorted = [...new Set(available)].sort((a, b) => a - b);
  if (!sorted.length)
    throw new PackValidationError([
      packIssue("atlas.variants", "atlas variant set is empty"),
    ]);
  return (sorted.find((value) => value >= required) ?? sorted.at(-1)) as
    1 | 2 | 4;
}
