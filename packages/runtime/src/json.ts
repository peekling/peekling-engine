import { packIssue, PackValidationError } from "./errors.js";

const MAX_JSON_NESTING = 64;
const JSON_NESTING_ERROR = 0;

/** Parse bounded JSON while rejecting ambiguous duplicate object keys. */
export function parseDataText(
  text: string,
  label: string,
  maxBytes = 64 * 1024,
): unknown {
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new PackValidationError([
      packIssue(`${label}.size`, `${label} exceeds ${maxBytes} bytes`),
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new PackValidationError([
      packIssue(`${label}.json`, `${label} is not valid JSON`),
    ]);
  }
  let duplicate: string | undefined;
  try {
    duplicate = firstDuplicateKey(text);
  } catch (cause) {
    if (cause !== JSON_NESTING_ERROR) throw cause;
    throw new PackValidationError([
      packIssue(
        `${label}.depth`,
        `${label} nesting exceeds ${MAX_JSON_NESTING} levels`,
      ),
    ]);
  }
  if (duplicate !== undefined) {
    throw new PackValidationError([
      packIssue(
        `${label}.duplicate-key`,
        `${label} contains duplicate object key ${JSON.stringify(duplicate)}`,
      ),
    ]);
  }
  return parsed;
}

function firstDuplicateKey(text: string): string | undefined {
  let cursor = 0;
  let duplicate: string | undefined;
  const space = () => {
    while (/\s/.test(text[cursor] ?? "")) cursor++;
  };
  const string = (): string => {
    const start = cursor++;
    while (cursor < text.length) {
      if (text[cursor] === "\\") cursor += 2;
      else if (text[cursor++] === '"') break;
    }
    return JSON.parse(text.slice(start, cursor)) as string;
  };
  const value = (depth = 0): void => {
    space();
    if (text[cursor] === "{") {
      if (depth >= MAX_JSON_NESTING) throw JSON_NESTING_ERROR;
      cursor++;
      const keys = new Set<string>();
      space();
      while (text[cursor] !== "}") {
        const key = string();
        if (keys.has(key) && duplicate === undefined) duplicate = key;
        keys.add(key);
        space();
        cursor++;
        value(depth + 1);
        space();
        if (text[cursor] === ",") {
          cursor++;
          space();
        } else break;
      }
      cursor++;
      return;
    }
    if (text[cursor] === "[") {
      if (depth >= MAX_JSON_NESTING) throw JSON_NESTING_ERROR;
      cursor++;
      space();
      while (text[cursor] !== "]") {
        value(depth + 1);
        space();
        if (text[cursor] === ",") {
          cursor++;
          space();
        } else break;
      }
      cursor++;
      return;
    }
    if (text[cursor] === '"') {
      string();
      return;
    }
    while (cursor < text.length && !/[\s,}\]]/.test(text[cursor]!)) cursor++;
  };
  value();
  return duplicate;
}
