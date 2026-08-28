import {
  compactRuntimeDiagnostics,
  runtimeMessage,
} from "./runtime-diagnostics.js";

const ISSUE_CODE_SEPARATOR = "\0";

export type PackLoadFailureCategory =
  | "abort"
  | "decode"
  | "hash"
  | "http"
  | "image"
  | "integrity"
  | "mime"
  | "network"
  | "size"
  | "timeout"
  | "validation";

export class PackLoadError extends Error {
  readonly code: string;
  readonly category: PackLoadFailureCategory;

  constructor(
    code: string,
    category: PackLoadFailureCategory,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "PackLoadError";
    this.code = code;
    this.category = category;
  }
}

export function packIssue(code: string, detail: string): string {
  const message = runtimeMessage(code, detail);
  return compactRuntimeDiagnostics
    ? message
    : `${message}${ISSUE_CODE_SEPARATOR}${code}`;
}

export function addPackIssue(
  issues: string[],
  code: string,
  detail: string,
): void {
  issues.push(packIssue(code, detail));
}

export function throwPackIssue(code: string, detail: string): never {
  throw new PackValidationError([packIssue(code, detail)]);
}

export class PackValidationError extends Error {
  readonly issues: readonly string[];
  readonly issueCodes: readonly string[];

  constructor(issues: readonly string[], issueCodes: readonly string[] = []) {
    let publicIssues = issues;
    let decodedCodes = issues;
    if (!compactRuntimeDiagnostics) {
      const messages: string[] = [];
      const codes: string[] = [];
      for (const issue of issues) {
        const separator = issue.lastIndexOf(ISSUE_CODE_SEPARATOR);
        if (separator < 0) {
          messages.push(issue);
        } else {
          const code = issue.slice(separator + 1);
          messages.push(separator ? issue.slice(0, separator) : code);
          codes.push(code);
        }
      }
      publicIssues = messages;
      decodedCodes = codes;
    }
    super(
      runtimeMessage(
        `pack:${publicIssues.join(",")}`,
        () =>
          `Invalid Peekling character pack:\n- ${publicIssues.join("\n- ")}`,
      ),
    );
    this.name = "PackValidationError";
    this.issues = publicIssues;
    this.issueCodes = issueCodes.length ? issueCodes : decodedCodes;
  }
}
