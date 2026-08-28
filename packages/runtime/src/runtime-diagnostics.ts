declare const __PEEKLING_COMPACT_ERRORS__: boolean;

export const compactRuntimeDiagnostics =
  typeof __PEEKLING_COMPACT_ERRORS__ !== "undefined" &&
  __PEEKLING_COMPACT_ERRORS__;

export const runtimeMessage: (
  code: string,
  detail: string | (() => string),
) => string = compactRuntimeDiagnostics
  ? (code) => code
  : (_code, detail) => (typeof detail === "function" ? detail() : detail);
