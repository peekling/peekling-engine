import { snapshotPackData } from "@peekling/runtime/pack";

export const CODEX_V2_WIDTH = 1536;
export const CODEX_V2_HEIGHT = 2288;
export const CODEX_V2_COLUMNS = 8;
export const CODEX_V2_ROWS = 11;
export const CODEX_V2_CELL_WIDTH = 192;
export const CODEX_V2_CELL_HEIGHT = 208;
export const CODEX_V2_DEFAULT_FPS = 8;

export interface CodexSidecar {
  format: 1;
  adapter: "codex-pet-v2";
  license: string;
  provenance: {
    author: string;
    source: string;
    rights: string;
  };
  reactions?: Record<string, string>;
}

export interface CodexAtlasInfo {
  fileName: "spritesheet.webp" | "spritesheet.png";
  width: number;
  height: number;
  mimeType: "image/webp" | "image/png";
  hasAlpha: boolean;
  sha256: string;
  byteLength?: number;
}

export interface AdaptCodexOptions {
  pet: unknown;
  sidecar: unknown;
  atlas: CodexAtlasInfo;
  allowSelfHostedPng?: boolean;
}

interface CodexStateBase {
  frames: number[];
  loop: boolean;
}

export type CodexState =
  | (CodexStateBase & { fps: number; durations?: never })
  | (CodexStateBase & { durations: number[]; fps?: never });

export interface AdaptedCodexPack {
  name: string;
  displayName: string;
  version: string;
  license: string;
  atlas: {
    src: string;
    sha256: string;
    columns: 8;
    rows: 11;
    cellWidth: 192;
    cellHeight: 208;
  };
  states: Record<string, CodexState>;
  defaultScale: 1;
  directionalStates: Record<
    "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW",
    string
  >;
  reactionStates: Record<string, string>;
  source: {
    kind: "codex-pet-v2";
    pet: Readonly<Record<string, unknown>>;
    sidecar: CodexSidecar;
    legacyFlat8Fps: boolean;
  };
}

const DEFINITIONS = [
  ["idle", 0, 6, [1680, 660, 660, 840, 840, 1920]],
  ["running-right", 1, 8, [120, 120, 120, 120, 120, 120, 120, 220]],
  ["running-left", 2, 8, [120, 120, 120, 120, 120, 120, 120, 220]],
  ["waving", 3, 4, [140, 140, 140, 280]],
  ["jumping", 4, 5, [140, 140, 140, 140, 280]],
  ["failed", 5, 8, [140, 140, 140, 140, 140, 140, 140, 240]],
  ["waiting", 6, 6, [150, 150, 150, 150, 150, 260]],
  ["running", 7, 6, [120, 120, 120, 120, 120, 220]],
  ["review", 8, 6, [150, 150, 150, 150, 150, 280]],
] as const;
const STANDARD_STATES = new Set(DEFINITIONS.map(([name]) => name));
const SPDX_LICENSE =
  /^(?:[A-Za-z0-9][A-Za-z0-9.-]{0,63}|DocumentRef-[A-Za-z0-9][A-Za-z0-9.-]{0,31}:LicenseRef-[A-Za-z0-9][A-Za-z0-9.-]{0,31})$/;
const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const CODEX_REACTION_DEFAULTS = Object.freeze({
  click: "waving",
  "double-click": "jumping",
  "context-click": "waving",
  scroll: "waiting",
  success: "jumping",
  happy: "waving",
  error: "failed",
});

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(
  value: unknown,
  field: string,
  issues: string[],
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    issues.push(
      `${field} must be a non-empty data-safe string of at most 512 characters`,
    );
    return undefined;
  }
  return value;
}

function validateSidecar(
  input: unknown,
  issues: string[],
): CodexSidecar | undefined {
  if (!object(input)) {
    issues.push("sidecar must be an object");
    return undefined;
  }
  for (const key of Object.keys(input))
    if (
      !["format", "adapter", "license", "provenance", "reactions"].includes(key)
    )
      issues.push(`sidecar.${key} is not allowed`);
  if (input.format !== 1) issues.push("sidecar.format must be 1");
  if (input.adapter !== "codex-pet-v2")
    issues.push('sidecar.adapter must be "codex-pet-v2"');
  const license = cleanString(input.license, "sidecar.license", issues);
  if (license && !SPDX_LICENSE.test(license))
    issues.push("sidecar.license must be an SPDX identifier or LicenseRef");
  if (!object(input.provenance)) {
    issues.push("sidecar.provenance must be an object");
    return undefined;
  }
  for (const key of Object.keys(input.provenance))
    if (!["author", "source", "rights"].includes(key))
      issues.push(`sidecar.provenance.${key} is not allowed`);
  const author = cleanString(
    input.provenance.author,
    "sidecar.provenance.author",
    issues,
  );
  const source = cleanString(
    input.provenance.source,
    "sidecar.provenance.source",
    issues,
  );
  const rights = cleanString(
    input.provenance.rights,
    "sidecar.provenance.rights",
    issues,
  );
  const reactions: Record<string, string> = {};
  if (input.reactions !== undefined) {
    if (!object(input.reactions) || Object.keys(input.reactions).length > 32) {
      issues.push(
        "sidecar.reactions must be an object with at most 32 entries",
      );
    } else {
      for (const [semantic, state] of Object.entries(input.reactions)) {
        if (
          !/^[a-z][a-z0-9-]{0,63}$/.test(semantic) ||
          typeof state !== "string" ||
          (!STANDARD_STATES.has(state as (typeof DEFINITIONS)[number][0]) &&
            !/^look:(?:000|\d{3}(?:\.5)?)$/.test(state))
        ) {
          issues.push(`sidecar.reactions.${semantic} is invalid`);
        } else {
          reactions[semantic] = state;
        }
      }
    }
  }
  if (!license || !author || !source || !rights) return undefined;
  return {
    format: 1,
    adapter: "codex-pet-v2",
    license,
    provenance: { author, source, rights },
    ...(Object.keys(reactions).length ? { reactions } : {}),
  };
}

function explicitTiming(
  pet: Record<string, unknown>,
  name: string,
  frames: number,
): number[] | undefined {
  for (const field of ["animations", "animationDefinitions"]) {
    const container = pet[field];
    if (!object(container) || !object(container[name])) continue;
    const durations = container[name].frameDurations;
    if (durations === undefined) continue;
    if (
      !Array.isArray(durations) ||
      durations.length !== frames ||
      durations.some(
        (duration) =>
          !Number.isFinite(duration) ||
          (duration as number) < 16 ||
          (duration as number) > 10_000,
      ) ||
      durations.reduce((sum, duration) => sum + Number(duration), 0) > 60_000
    ) {
      throw new TypeError(
        `${field}.${name}.frameDurations must match frames and contain 16-10000 ms values totaling at most 60000 ms`,
      );
    }
    {
      return [...durations] as number[];
    }
  }
  return undefined;
}

function hasExplicitTimings(pet: Record<string, unknown>): boolean {
  return DEFINITIONS.some(
    ([name, , frames]) => explicitTiming(pet, name, frames) !== undefined,
  );
}

export function codexLocomotionForDelta(
  deltaX: number,
): "running-left" | "running-right" {
  return deltaX < 0 ? "running-left" : "running-right";
}

export function lookStateForAngle(degrees: number): string {
  if (!Number.isFinite(degrees)) throw new TypeError("degrees must be finite");
  const normalized = ((degrees % 360) + 360) % 360;
  const step = Math.round(normalized / 22.5) % 16;
  const value = step * 22.5;
  return `look:${value === 0 ? "000" : Number.isInteger(value) ? String(value).padStart(3, "0") : String(value).padStart(5, "0")}`;
}

export function adaptCodexPetV2(options: AdaptCodexOptions): AdaptedCodexPack {
  let checked: Record<string, unknown>;
  try {
    const snapshot = snapshotPackData(options);
    if (!object(snapshot)) throw new TypeError("$ must be a plain data object");
    checked = snapshot;
  } catch (cause) {
    throw new TypeError(
      `Invalid Codex Pet v2 bundle:\n- ${cause instanceof Error ? cause.message : "input cannot be inspected safely"}`,
    );
  }
  for (const key of Object.keys(checked)) {
    if (!["pet", "sidecar", "atlas", "allowSelfHostedPng"].includes(key)) {
      throw new TypeError(
        `Invalid Codex Pet v2 bundle:\n- options.${key} is not allowed`,
      );
    }
  }
  const issues: string[] = [];
  if (!object(checked.pet))
    throw new TypeError(
      "Invalid Codex Pet v2 bundle:\n- pet.json must be an object",
    );
  const pet = checked.pet;
  const serialized = JSON.stringify(pet);
  if (new TextEncoder().encode(serialized).byteLength > 64 * 1024) {
    issues.push("pet.json exceeds 64 KiB");
  }
  if (pet.spriteVersionNumber !== 2)
    issues.push("spriteVersionNumber must be 2");
  const sidecar = validateSidecar(checked.sidecar, issues);
  if (!object(checked.atlas))
    throw new TypeError(
      "Invalid Codex Pet v2 bundle:\n- atlas must be an object",
    );
  const atlas = checked.atlas;
  for (const key of Object.keys(atlas)) {
    if (
      ![
        "fileName",
        "width",
        "height",
        "mimeType",
        "hasAlpha",
        "sha256",
        "byteLength",
      ].includes(key)
    ) {
      issues.push(`atlas.${key} is not allowed`);
    }
  }
  if (
    checked.allowSelfHostedPng !== undefined &&
    typeof checked.allowSelfHostedPng !== "boolean"
  )
    issues.push("allowSelfHostedPng must be boolean");
  if (atlas.width !== CODEX_V2_WIDTH || atlas.height !== CODEX_V2_HEIGHT) {
    issues.push(`atlas must be exactly ${CODEX_V2_WIDTH}x${CODEX_V2_HEIGHT}`);
  }
  const webp =
    atlas.fileName === "spritesheet.webp" && atlas.mimeType === "image/webp";
  const png =
    checked.allowSelfHostedPng === true &&
    atlas.fileName === "spritesheet.png" &&
    atlas.mimeType === "image/png";
  if (!webp && !png)
    issues.push(
      "atlas must be spritesheet.webp (or explicitly allowed self-hosted PNG)",
    );
  if (atlas.hasAlpha !== true) issues.push("atlas must include transparency");
  if (
    typeof atlas.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(atlas.sha256)
  ) {
    issues.push("atlas.sha256 must be 64 lowercase hexadecimal characters");
  }
  if (
    atlas.byteLength !== undefined &&
    (typeof atlas.byteLength !== "number" ||
      !Number.isSafeInteger(atlas.byteLength) ||
      atlas.byteLength < 1 ||
      atlas.byteLength > 32 * 1024 * 1024)
  ) {
    issues.push(
      "atlas byteLength must be a positive safe integer at most 32 MiB",
    );
  }
  if (issues.length || !sidecar) {
    throw new TypeError(
      `Invalid Codex Pet v2 bundle:\n- ${issues.join("\n- ")}`,
    );
  }
  const atlasFileName = atlas.fileName as CodexAtlasInfo["fileName"];

  const states: Record<string, CodexState> = {};
  const legacyFlat8Fps = !hasExplicitTimings(pet);
  for (const [name, row, frameCount, defaults] of DEFINITIONS) {
    const frames = Array.from(
      { length: frameCount },
      (_, column) => row * 8 + column,
    );
    const sourceDurations = explicitTiming(pet, name, frameCount);
    states[name] = {
      frames,
      loop: true,
      durations: sourceDurations ?? [...defaults],
    };
  }
  for (let step = 0; step < 16; step++) {
    const degrees = step * 22.5;
    const name = lookStateForAngle(degrees);
    states[name] = {
      frames: [9 * 8 + step],
      fps: CODEX_V2_DEFAULT_FPS,
      loop: true,
    };
  }

  const petName =
    typeof pet.name === "string" &&
    pet.name.length <= 120 &&
    !/:\/\//.test(pet.name) &&
    /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,119}$/u.test(pet.name)
      ? pet.name
      : "codex-pet";
  const packName = petName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  const petVersion =
    typeof pet.version === "string" && SEMVER.test(pet.version)
      ? pet.version
      : "2.0.0";
  const sourcePet: Record<string, string | number> = {
    spriteVersionNumber: 2,
  };
  if (petName !== "codex-pet") sourcePet.name = petName;
  if (petVersion !== "2.0.0") sourcePet.version = petVersion;
  return {
    name: /^[a-z][a-z0-9-]{0,63}$/.test(packName) ? packName : "codex-pet",
    displayName: petName,
    version: petVersion,
    license: sidecar.license,
    atlas: {
      src: atlasFileName,
      sha256: atlas.sha256 as string,
      columns: 8,
      rows: 11,
      cellWidth: 192,
      cellHeight: 208,
    },
    states,
    defaultScale: 1,
    directionalStates: {
      N: "running-right",
      NE: "running-right",
      E: "running-right",
      SE: "running-right",
      S: "running-right",
      SW: "running-left",
      W: "running-left",
      NW: "running-left",
    },
    reactionStates: { ...CODEX_REACTION_DEFAULTS, ...sidecar.reactions },
    source: {
      kind: "codex-pet-v2",
      pet: Object.freeze(sourcePet),
      sidecar,
      legacyFlat8Fps,
    },
  };
}
