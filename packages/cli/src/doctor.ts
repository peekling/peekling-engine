import { preflight, type PreflightResult } from "@peekling/preflight";
import { parseDataText } from "@peekling/runtime/pack";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

const MAX_DOCTOR_INPUT_BYTES = 64 * 1024;

export interface DoctorOptions {
  readonly packPath?: string;
  readonly baseUrl?: string;
  readonly json?: boolean;
}

export async function runDoctor(
  configPath: string,
  options: DoctorOptions = {},
): Promise<{ report: PreflightResult; output: string; exitCode: 0 | 1 }> {
  let configuration: unknown;
  try {
    configuration = await readJsonData(configPath, "configuration");
  } catch (cause) {
    return inputFailure(
      "$input.configuration",
      cause,
      "Pass a readable JSON Configuration file",
      options.json,
    );
  }
  let pack: unknown;
  if (options.packPath) {
    try {
      pack = await readJsonData(options.packPath, "Pack");
    } catch (cause) {
      return inputFailure(
        "$input.pack",
        cause,
        "Pass a readable JSON Pack file",
        options.json,
      );
    }
  }
  const report = preflight(configuration, {
    ...(pack !== undefined ? { pack } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  });
  return {
    report,
    output: options.json ? formatJson(report) : formatHuman(report),
    exitCode: report.valid ? 0 : 1,
  };
}

function inputFailure(
  path: string,
  cause: unknown,
  fix: string,
  json = false,
): { report: PreflightResult; output: string; exitCode: 1 } {
  const report: PreflightResult = {
    valid: false,
    errors: [
      {
        code: "invalid-input",
        path,
        message: cause instanceof Error ? cause.message : "Input is invalid",
        fix,
      },
    ],
    warnings: [],
  };
  return {
    report,
    output: json ? formatJson(report) : formatHuman(report),
    exitCode: 1,
  };
}

async function readJsonData(target: string, label: string): Promise<unknown> {
  if (path.extname(target).toLowerCase() !== ".json") {
    throw new Error(
      `${label} input must be a JSON data file. Doctor never imports project code.`,
    );
  }
  const initial = await lstat(target);
  if (initial.isSymbolicLink())
    throw new Error(`${label} input must not be a symbolic link`);
  if (!initial.isFile())
    throw new Error(`${label} input must be a regular file`);
  if (initial.size > MAX_DOCTOR_INPUT_BYTES) {
    throw new Error(`${label} input exceeds 65536 bytes`);
  }
  const handle = await open(target, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new Error(`${label} input must be a regular file`);
    }
    if (opened.dev !== initial.dev || opened.ino !== initial.ino) {
      throw new Error(`${label} input changed before it could be read`);
    }
    if (opened.size > MAX_DOCTOR_INPUT_BYTES) {
      throw new Error(`${label} input exceeds 65536 bytes`);
    }
    const bytes = Buffer.alloc(MAX_DOCTOR_INPUT_BYTES + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_DOCTOR_INPUT_BYTES) {
      throw new Error(`${label} input exceeds 65536 bytes`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, offset),
      );
    } catch (cause) {
      throw new Error(`${label} input must be valid UTF-8`, { cause });
    }
    return parseDataText(text, `${label} ${target}`);
  } finally {
    await handle.close();
  }
}

function formatJson(report: PreflightResult): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function formatHuman(report: PreflightResult): string {
  const lines = [
    report.valid
      ? "Peekling Doctor found no configuration errors."
      : `Peekling Doctor found ${report.errors.length} configuration error${report.errors.length === 1 ? "" : "s"}.`,
  ];
  for (const [label, issues] of [
    ["ERROR", report.errors],
    ["WARNING", report.warnings],
  ] as const) {
    for (const issue of issues) {
      lines.push(
        "",
        `${label} ${issue.code} at ${issue.path}`,
        `  ${issue.message}`,
        `  Fix: ${issue.fix}`,
      );
    }
  }
  if (report.warnings.length > 0) {
    lines.push(
      "",
      `${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"} need review.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
