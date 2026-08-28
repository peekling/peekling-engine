import { runtimeMessage } from "./runtime-diagnostics.js";

export class OwnDataError extends TypeError {
  readonly issueCode: string | undefined;

  constructor(path: string, reason: string, issueCode?: string) {
    super(`${path} ${reason}`);
    this.name = "OwnDataError";
    this.issueCode = issueCode;
  }
}

export interface OwnDataSnapshotPolicy {
  readonly json?: boolean;
  readonly key?: (value: string) => boolean;
  readonly maxArrayLength?: number;
  readonly maxDepth?: number;
  readonly maxObjectKeys?: number;
  readonly maxStringLength?: number;
  readonly maxValues?: number;
}

type SnapshotMode = "configuration" | "own" | "pack";

interface SnapshotResult {
  readonly value: unknown;
  readonly ownSafe: boolean;
  readonly packSafe: boolean;
}

interface CloneRecord {
  readonly value: object;
  ownSafe?: boolean;
  packSafe?: boolean;
}

const trustedConfigurations = new WeakSet<object>();
const trustedOwnData = new WeakSet<object>();
const trustedPackData = new WeakSet<object>();

function plain(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function trusted(input: unknown, mode: SnapshotMode): input is object {
  if (typeof input !== "object" || input === null) return false;
  if (mode === "configuration") {
    return trustedConfigurations.has(input) || trustedOwnData.has(input);
  }
  return mode === "pack"
    ? trustedPackData.has(input)
    : trustedOwnData.has(input);
}

function mark(value: object, ownSafe: boolean, packSafe: boolean): void {
  if (ownSafe) trustedOwnData.add(value);
  if (packSafe) trustedPackData.add(value);
}

function snapshotData<T>(
  input: T,
  mode: SnapshotMode,
  policy?: Readonly<OwnDataSnapshotPolicy>,
): T {
  if (!policy && trusted(input, mode)) return input;
  let nodes = 0;
  let values = 0;
  const active = new WeakSet<object>();
  const clones = new WeakMap<object, CloneRecord>();

  const fail = (path: string, issueCode: string, detail: string): never => {
    throw new OwnDataError(path, runtimeMessage(issueCode, detail), issueCode);
  };

  const visit = (
    value: unknown,
    path: string,
    depth: number,
  ): SnapshotResult => {
    if (policy?.maxDepth !== undefined && depth > policy.maxDepth) {
      return fail(path, "data.depth", "exceeds maximum depth");
    }
    values += 1;
    if (policy?.maxValues !== undefined && values > policy.maxValues) {
      return fail(path, "data.nodes", "exceeds maximum object count");
    }
    if (value === null || typeof value === "boolean") {
      return { value, ownSafe: true, packSafe: true };
    }
    if (typeof value === "string") {
      if (
        policy?.maxStringLength !== undefined &&
        value.length > policy.maxStringLength
      ) {
        return fail(path, "data.string", "exceeds maximum string length");
      }
      return { value, ownSafe: true, packSafe: true };
    }
    if (typeof value === "number") {
      if (policy?.json && !Number.isFinite(value)) {
        return fail(path, "data.type", "contains unsupported data");
      }
      return { value, ownSafe: true, packSafe: true };
    }
    if (typeof value === "undefined") {
      if (policy?.json) {
        return fail(path, "data.type", "contains unsupported data");
      }
      return { value, ownSafe: true, packSafe: true };
    }
    if (typeof value === "function") {
      if (mode === "pack" || policy?.json) {
        return fail(path, "data.type", "contains unsupported data");
      }
      return { value, ownSafe: true, packSafe: false };
    }
    if (typeof value !== "object") {
      return fail(path, "data.type", "contains unsupported data");
    }
    if (
      mode === "configuration" &&
      (path === "$.document" || path === "$.window")
    ) {
      return { value, ownSafe: false, packSafe: false };
    }
    if (depth > 32) return fail(path, "data.depth", "exceeds maximum depth");
    nodes += 1;
    if (nodes > 20_000)
      return fail(path, "data.nodes", "exceeds maximum object count");
    const previous = clones.get(value);
    if (previous) {
      if (active.has(value)) {
        return fail(path, "data.cycle", "must not contain cycles");
      }
      if (!policy) {
        return {
          value: previous.value,
          ownSafe: previous.ownSafe!,
          packSafe: previous.packSafe!,
        };
      }
    }

    let keys: readonly PropertyKey[];
    try {
      keys = Reflect.ownKeys(value);
    } catch {
      return fail(path, "data.reflect", "cannot be inspected safely");
    }
    if (keys.some((key) => typeof key !== "string")) {
      return fail(path, "data.symbol", "contains symbol properties");
    }

    if (Array.isArray(value)) {
      if (value.length > Math.min(4_096, policy?.maxArrayLength ?? 4_096))
        return fail(path, "data.array", "exceeds maximum array length");
      if (
        keys.length !== value.length + 1 ||
        keys.some(
          (key) =>
            key !== "length" &&
            (!/^\d+$/.test(key as string) || Number(key) >= value.length),
        )
      )
        return fail(path, "data.array-own", "contains custom array properties");
      const output: unknown[] = [];
      const record: CloneRecord = { value: output };
      clones.set(value, record);
      active.add(value);
      let ownSafe = true;
      let packSafe = true;
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor || descriptor.get || descriptor.set) {
          return fail(
            `${path}[${index}]`,
            "data.descriptor",
            "must be an own data property",
          );
        }
        const item = visit(descriptor.value, `${path}[${index}]`, depth + 1);
        output.push(item.value);
        ownSafe &&= item.ownSafe;
        packSafe &&= item.packSafe;
      }
      active.delete(value);
      const frozen = Object.freeze(output);
      record.ownSafe = ownSafe;
      record.packSafe = packSafe;
      mark(frozen, ownSafe, packSafe);
      return { value: frozen, ownSafe, packSafe };
    }

    let isPlain: boolean;
    try {
      isPlain = plain(value);
    } catch {
      return fail(path, "data.reflect", "cannot be inspected safely");
    }
    if (!isPlain)
      return fail(
        path,
        "data.plain",
        "must use this realm's Object prototype or a null prototype",
      );
    if (keys.length > Math.min(1_024, policy?.maxObjectKeys ?? 1_024))
      return fail(path, "data.keys", "exceeds maximum property count");
    const output = Object.create(null) as Record<string, unknown>;
    const record: CloneRecord = { value: output };
    clones.set(value, record);
    active.add(value);
    let ownSafe = true;
    let packSafe = true;
    for (const key of keys as string[]) {
      if (policy?.key && !policy.key(key)) {
        fail(`${path}.${key}`, "data.key", "contains an invalid property name");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) {
        return fail(
          `${path}.${key}`,
          "data.descriptor",
          "must be an own data property",
        );
      }
      const item = visit(descriptor.value, `${path}.${key}`, depth + 1);
      output[key] = item.value;
      ownSafe &&= item.ownSafe;
      packSafe &&= item.packSafe;
    }
    active.delete(value);
    const frozen = Object.freeze(output);
    record.ownSafe = ownSafe;
    record.packSafe = packSafe;
    mark(frozen, ownSafe, packSafe);
    return { value: frozen, ownSafe, packSafe };
  };

  try {
    const result = visit(input, "$", 0);
    if (
      mode === "configuration" &&
      typeof result.value === "object" &&
      result.value !== null
    ) {
      trustedConfigurations.add(result.value);
    }
    return result.value as T;
  } catch (cause) {
    if (cause instanceof OwnDataError) throw cause;
    return fail("$", "data.reflect", "cannot be inspected safely");
  }
}

export function snapshotOwnData<T>(
  input: T,
  policy?: Readonly<OwnDataSnapshotPolicy>,
): T {
  return snapshotData(input, "own", policy);
}

/** Shared package-family boundary for data-only Pack and adapter input. */
export function snapshotPackData<T>(input: T): T {
  return snapshotData(input, "pack");
}

export function snapshotConfiguration<T>(input: T): T {
  return snapshotData(input, "configuration");
}
