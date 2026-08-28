#!/usr/bin/env node
import {
  createPack,
  importCodexPet,
  packAuthoringSource,
  validatePackDirectory,
} from "./index.js";
import { runDoctor } from "./doctor.js";

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function argumentsFor(
  args: string[],
  positionalLimit: number,
  valueOptions: readonly string[] = [],
  booleanOptions: readonly string[] = [],
): { positionals: string[]; options: ReadonlyMap<string, string | true> } {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      if (positionals.length >= positionalLimit) {
        throw new Error(`Unexpected positional argument ${argument}`);
      }
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (options.has(name)) throw new Error(`Duplicate option --${name}`);
    if (booleanOptions.includes(name)) {
      options.set(name, true);
      continue;
    }
    if (!valueOptions.includes(name)) {
      throw new Error(`Unknown option --${name}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    }
    options.set(name, value);
    index += 1;
  }
  return { positionals, options };
}

async function main(args: string[]): Promise<void> {
  const [command] = args;
  if (command === "doctor") {
    const { positionals, options } = argumentsFor(
      args.slice(1),
      1,
      ["pack", "base-url"],
      ["json"],
    );
    const [first] = positionals;
    const packPath = options.get("pack");
    const baseUrl = options.get("base-url");
    const result = await runDoctor(
      required(
        first,
        "Usage: peekling doctor <configuration.json> [--pack character.json] [--json]",
      ),
      {
        ...(typeof packPath === "string" ? { packPath } : {}),
        ...(typeof baseUrl === "string" ? { baseUrl } : {}),
        ...(options.get("json") === true ? { json: true } : {}),
      },
    );
    process.stdout.write(result.output);
    process.exitCode = result.exitCode;
    return;
  }
  if (command === "create") {
    const { positionals, options } = argumentsFor(args.slice(1), 1, ["name"]);
    const [first] = positionals;
    await createPack(
      required(first, "Usage: peekling create <directory> --name <name>"),
      required(
        options.get("name") as string | undefined,
        "create requires --name",
      ),
    );
    console.log(`Created native Peekling pack at ${first}`);
    return;
  }
  if (command === "validate") {
    const { positionals } = argumentsFor(args.slice(1), 1);
    const [first] = positionals;
    const result = await validatePackDirectory(
      required(first, "Usage: peekling validate <directory>"),
    );
    console.log(
      `Valid ${result.name}@${result.version}: ${result.states} states, ${result.atlas.width}x${result.atlas.height} atlas (${result.atlas.bytes} bytes)`,
    );
    return;
  }
  if (command === "pack") {
    const { positionals, options } = argumentsFor(args.slice(1), 1, ["out"]);
    const [first] = positionals;
    const output = required(
      options.get("out") as string | undefined,
      "pack requires --out",
    );
    await packAuthoringSource(
      required(
        first,
        "Usage: peekling pack <source-directory> --out <directory>",
      ),
      output,
    );
    console.log(`Compiled dense native pack to ${output}`);
    return;
  }
  if (command === "import") {
    const { positionals, options } = argumentsFor(
      args.slice(1),
      2,
      ["out", "license", "author", "source", "rights"],
      ["allow-png"],
    );
    const [kind, second] = positionals;
    if (kind !== "codex") {
      throw new Error(
        "Usage: peekling import codex <input> --out <directory> [metadata]",
      );
    }
    const input = required(
      second,
      "Usage: peekling import codex <input> --out <directory> [metadata]",
    );
    await importCodexPet(
      input,
      required(
        options.get("out") as string | undefined,
        "import codex requires --out",
      ),
      {
        license: required(
          options.get("license") as string | undefined,
          "import codex requires --license",
        ),
        author: required(
          options.get("author") as string | undefined,
          "import codex requires --author",
        ),
        source: required(
          options.get("source") as string | undefined,
          "import codex requires --source",
        ),
        rights: required(
          options.get("rights") as string | undefined,
          "import codex requires --rights",
        ),
        ...(options.get("allow-png") === true ? { allowPng: true } : {}),
      },
    );
    console.log(
      `Imported Codex Pet v2 bundle to ${options.get("out") as string}`,
    );
    return;
  }
  throw new Error(
    "Usage: peekling <doctor|create|pack|validate|import codex> ...",
  );
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
