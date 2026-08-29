import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import * as defaults from "../packages/runtime/dist/defaults.js";
import { preflight as runtimePreflight } from "../packages/runtime/dist/preflight.js";
import { validateRuntimeConfiguration } from "../packages/runtime/dist/runtime-validation.js";
import { preflight as publicPreflight } from "../packages/preflight/dist/index.js";
import {
  invalidSerializableConfigurationCases,
  invalidSerializableUrlCases,
  invalidSurfaceColorCases,
  nullSerializableConfigurationCase,
  validSerializableUrlCases,
  validSurfaceColorCases,
  validSerializableConfigurationCases,
} from "./fixtures/configuration-parity.mjs";

const path = "docs/schema/peekling-options.schema.json";
const typePath = "docs/schema/peekling-options-v0.1.d.ts";

test("the authoritative options schema is valid JSON with closed objects", async () => {
  const text = await readFile(path, "utf8");
  const types = await readFile(typePath, "utf8");
  const schema = JSON.parse(text);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.equal(JSON.stringify(schema).includes('"examples"'), false);
  for (const field of [
    "format",
    "character",
    "pack",
    "packUrl",
    "density",
    "position",
    "plan",
    "content",
    "name",
    "theme",
    "accessibility",
    "diagnostics",
  ]) {
    assert.ok(schema.properties[field], `schema contains ${field}`);
  }
  for (const definition of [
    "plan",
    "planRule",
    "planEffect",
    "planCondition",
    "planSurfaceEffect",
    "planSurfaceOrdering",
    "runtimeStyles",
    "contentRegistry",
    "contentItem",
    "contentSurface",
    "theme",
    "jsonValue",
    "semver",
    "spdxLicense",
    "assetPath",
  ]) {
    assert.ok(schema.$defs[definition], `schema defines ${definition}`);
  }
  for (const deadDefinition of ["region", "viewportRegion", "sectionRegion"]) {
    assert.equal(deadDefinition in schema.$defs, false);
  }
  inspect(schema, "$", new Set());
  const optionsBody = types.match(
    /export interface SerializablePeeklingOptionFields \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(optionsBody);
  const typeFields = [
    ...optionsBody.matchAll(/^  ([A-Za-z][A-Za-z0-9]*)\?:/gm),
  ].map((match) => match[1]);
  assert.deepEqual(typeFields.sort(), Object.keys(schema.properties).sort());
  assertTypeShapesMatchSchema(types, schema);
  for (const typeName of [
    "Plan",
    "PlanRule",
    "PlanEffect",
    "PlanCondition",
    "ContentRegistry",
    "SurfaceTheme",
    "RuntimeStyleAsset",
    "AccessibilityOptions",
    "DiagnosticOptions",
    "JsonValue",
    "NativeManifest",
    "NormalizedPack",
  ]) {
    assert.match(types, new RegExp(`export (?:interface|type) ${typeName}\\b`));
  }
  assert.doesNotMatch(types, /export type PlanRegion\b/);

  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  });
  const validate = ajv.compile(schema);
  assert.equal(validate({}), false, "a Pack selection is required");
  assert.equal(
    validate({
      character: "peek",
      density: 2,
      position: { x: 80, y: 120 },
      plan: {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "main-clicked",
            when: {
              source: "browser",
              event: "pointer.click",
            },
            effect: {
              channels: ["surface:status"],
              surfaces: [
                {
                  id: "status",
                  contentId: "status",
                  disposition: "replace",
                },
              ],
            },
          },
        ],
      },
      content: {
        status: {
          "top-center": {
            text: "Ready",
            mountId: "continue",
          },
        },
      },
      diagnostics: { console: false, context: { variant: "b" } },
    }),
    true,
    JSON.stringify(validate.errors),
  );
  assert.equal(validate({ unknown: true }), false);
  assert.equal(validate({ format: 2 }), false);
  assert.equal(validate({ position: "100,200" }), false);

  const validateMotion = ajv.getSchema(`${schema.$id}#/$defs/planMotionEffect`);
  assert.ok(validateMotion);
  assert.equal(
    validateMotion({
      type: "horizontal-patrol",
      speed: 240,
      edgeInset: 24,
    }),
    true,
  );
  assert.equal(
    validateMotion({ type: "horizontal-patrol", arrivalRadius: 10 }),
    false,
  );
  assert.equal(
    validateMotion({ type: "follow-pointer", bottomOffset: 10 }),
    false,
  );

  const validateSection = ajv.getSchema(
    `${schema.$id}#/$defs/sectionCondition`,
  );
  assert.ok(validateSection);
  assert.equal(
    validateSection({
      source: "browser",
      event: "section.visibility",
      selector: "#main",
      phase: "while-visible",
      threshold: 0,
    }),
    false,
  );

  const validateState = ajv.getSchema(`${schema.$id}#/$defs/stateDefinition`);
  assert.ok(validateState);
  assert.equal(validateState({ frames: [0], loop: true, fps: 0.1 }), true);
  assert.equal(validateState({ frames: [0], loop: true, fps: 0.099 }), false);
  assert.equal(validateState({ frames: [0], loop: true, fps: 60 }), true);
  assert.equal(validateState({ frames: [0], loop: true, fps: 61 }), false);
  assert.equal(
    validateState({ frames: [0], loop: true, durations: [10_001] }),
    false,
  );
  assert.equal(
    validateState({ frames: [0], loop: true, fps: 1, durations: [1_000] }),
    false,
  );
});

test("schema default annotations match the runtime default table", async () => {
  const schema = JSON.parse(await readFile(path, "utf8"));
  assert.equal(schema.properties.format.default, defaults.DEFAULT_FORMAT);
  assert.equal(schema.properties.character.default, undefined);
  assert.equal(
    schema.properties.maxDensity.default,
    defaults.DEFAULT_MAX_DENSITY,
  );
  assert.equal(schema.properties.position.default, defaults.DEFAULT_POSITION);
  assert.equal(schema.properties.scale.default, undefined);
  assert.equal(
    schema.$defs.nativeManifest.properties.defaults.properties.scale.default,
    defaults.DEFAULT_NATIVE_SCALE,
  );
});

test("serializable schema and preflight reject the same shape corpus", async () => {
  const schema = JSON.parse(await readFile(path, "utf8"));
  const validate = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  }).compile(schema);
  const corpus = [
    {},
    { character: "peek", scale: 2, density: 2 },
    {
      character: "peek",
      styles: { url: "/peekling.css", integrity: "sha384-YWJj" },
    },
    { character: "peek", styles: { url: "javascript:alert(1)" } },
    {
      character: "peek",
      styles: { url: "/peekling.css", integrity: "not-sri" },
    },
    { character: "Not Safe" },
    { character: "peek", scale: 1.5 },
    { character: "peek", density: 3 },
    { character: "peek", position: "100,200" },
    { character: "peek", behaviors: ["idle"] },
    {
      character: "peek",
      plan: { baseline: { channels: ["state"], state: { state: "idle" } } },
    },
    {
      character: "peek",
      plan: {
        baseline: { channels: ["state"], state: { state: "idle" } },
        rules: [
          {
            id: "bad-source",
            when: { source: "host", event: "app.saved" },
            effect: { channels: ["state"], state: { state: "happy" } },
          },
        ],
      },
    },
    {
      character: "peek",
      plan: {
        baseline: { channels: ["state"], state: { state: "idle" } },
        rules: [
          {
            id: "bad-section",
            when: {
              source: "browser",
              event: "section.visibility",
              selector: "#main",
              phase: "sometimes",
            },
            effect: { channels: ["state"], state: { state: "happy" } },
          },
        ],
      },
    },
    { character: "peek", reactions: { click: "Not Safe" } },
    { character: "peek", touchReactions: { hover: "happy" } },
    { character: "peek", diagnostics: { debug: "yes" } },
    { character: "peek", unknown: true },
  ];
  for (const [index, options] of corpus.entries()) {
    const schemaValid = validate(options);
    const preflightValid = runtimePreflight(options).valid;
    assert.equal(
      preflightValid,
      schemaValid,
      `corpus ${index}: ${JSON.stringify(options)} schema=${JSON.stringify(validate.errors)}`,
    );
  }
});

test("continuous Plan Rules reject discrete surfaces and lifetimes everywhere", async () => {
  const schema = JSON.parse(await readFile(path, "utf8"));
  const validate = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  }).compile(schema);
  const configurations = [
    {
      name: "pointer movement with a surface",
      configuration: {
        character: "peek",
        plan: {
          baseline: {
            channels: ["state"],
            state: { state: "idle" },
          },
          rules: [
            {
              id: "pointer-status",
              when: { source: "browser", event: "pointer.move" },
              effect: {
                channels: ["surface:status"],
                surfaces: [{ id: "status", contentId: "status" }],
              },
            },
          ],
        },
        content: { status: { bottom: { text: "Ready" } } },
      },
    },
    {
      name: "continuous section visibility with a lifetime",
      configuration: {
        character: "peek",
        plan: {
          baseline: {
            channels: ["state"],
            state: { state: "idle" },
          },
          rules: [
            {
              id: "visible-state",
              when: {
                source: "browser",
                event: "section.visibility",
                selector: "#main",
                phase: "while-visible",
              },
              effect: {
                channels: ["state"],
                state: { state: "happy" },
                until: { type: "duration", ms: 100 },
              },
            },
          ],
        },
      },
    },
  ];

  for (const { name, configuration } of configurations) {
    assert.equal(validate(configuration), false, `${name}: JSON Schema`);
    assert.equal(
      runtimePreflight(configuration).valid,
      false,
      `${name}: runtime Preflight`,
    );
    assert.equal(
      publicPreflight(configuration).valid,
      false,
      `${name}: public Preflight`,
    );
  }
});

test("schema, Preflight, and runtime share one strict configuration corpus", async () => {
  const schema = JSON.parse(await readFile(path, "utf8"));
  const validate = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  }).compile(schema);
  const baseUrl = "http://site.example/page";

  for (const { name, configuration } of invalidSerializableConfigurationCases) {
    assert.equal(validate(configuration), false, `${name}: JSON Schema`);
    assert.equal(
      runtimePreflight(configuration, { baseUrl }).valid,
      false,
      `${name}: runtime Preflight`,
    );
    assert.equal(
      publicPreflight(configuration, { baseUrl }).valid,
      false,
      `${name}: public Preflight`,
    );
    assert.throws(
      () => validateRuntimeConfiguration(configuration, baseUrl),
      (error) => {
        assert.equal(error?.name, "PeeklingPreflightError", name);
        assert.equal(Array.isArray(error?.issues), true, name);
        if (name === "missing Pack selection") {
          assert.equal(error.issues[0]?.code, "manifest.selection");
          assert.equal(error.issues[0]?.path, "$");
        }
        return true;
      },
      `${name}: hatch validation`,
    );
  }

  for (const { name, configuration } of validSerializableConfigurationCases) {
    assert.equal(
      validate(configuration),
      true,
      `${name}: JSON Schema ${JSON.stringify(validate.errors)}`,
    );
    assert.equal(
      runtimePreflight(configuration, { baseUrl }).valid,
      true,
      `${name}: runtime Preflight`,
    );
    assert.equal(
      publicPreflight(configuration, { baseUrl }).valid,
      true,
      `${name}: public Preflight`,
    );
    assert.doesNotThrow(
      () => validateRuntimeConfiguration(configuration, baseUrl),
      `${name}: hatch validation`,
    );
  }
});

test("schema and both Preflight entry points reject null options", async () => {
  const schema = JSON.parse(await readFile(path, "utf8"));
  const validate = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  }).compile(schema);
  const { configuration } = nullSerializableConfigurationCase;

  assert.equal(validate(configuration), false);
  assert.equal(
    runtimePreflight(configuration, { baseUrl: "https://site.example/" }).valid,
    false,
  );
  assert.equal(
    publicPreflight(configuration, { baseUrl: "https://site.example/" }).valid,
    false,
  );
});

test("theme and indicator colors use one closed grammar across schema and validation", async () => {
  const schema = JSON.parse(await readFile(path, "utf8"));
  const validate = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  }).compile(schema);
  const baseUrl = "https://site.example/";
  const configuration = (value) => ({
    character: "peek",
    styles: { url: "./peekling.css" },
    theme: {
      background: value,
      color: value,
      linkColor: value,
      borderColor: value,
    },
    indicator: {
      label: "One update is waiting",
      color: value,
    },
  });

  for (const value of validSurfaceColorCases) {
    const options = configuration(value);
    assert.equal(validate(options), true, `${value}: JSON Schema`);
    assert.equal(
      runtimePreflight(options, { baseUrl }).valid,
      true,
      `${value}: runtime Preflight`,
    );
    assert.equal(
      publicPreflight(options, { baseUrl }).valid,
      true,
      `${value}: public Preflight`,
    );
    assert.doesNotThrow(
      () => validateRuntimeConfiguration(options, baseUrl),
      value,
    );
  }

  for (const value of invalidSurfaceColorCases) {
    const options = configuration(value);
    assert.equal(validate(options), false, `${value}: JSON Schema`);
    assert.equal(
      runtimePreflight(options, { baseUrl }).valid,
      false,
      `${value}: runtime Preflight`,
    );
    assert.equal(
      publicPreflight(options, { baseUrl }).valid,
      false,
      `${value}: public Preflight`,
    );
    assert.throws(
      () => validateRuntimeConfiguration(options, baseUrl),
      (error) => error?.name === "PeeklingPreflightError",
      value,
    );
  }
});

test("serializable URLs share one lexical and semantic admission policy", async () => {
  const schema = JSON.parse(await readFile(path, "utf8"));
  const validate = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  }).compile(schema);
  const baseUrl = "https://site.example/page";
  const configurations = (value) => [
    ["packUrl", { packUrl: value, styles: { url: "./peekling.css" } }],
    [
      "atlasUrl",
      {
        character: "peek",
        atlasUrl: value,
        styles: { url: "./peekling.css" },
      },
    ],
    ["styles.url", { character: "peek", styles: { url: value } }],
    [
      "content.link.href",
      {
        character: "peek",
        styles: { url: "./peekling.css" },
        content: {
          status: {
            bottom: { link: { label: "Details", href: value } },
          },
        },
      },
    ],
  ];

  for (const { name, value } of validSerializableUrlCases) {
    for (const [field, options] of configurations(value)) {
      const label = `${name} in ${field}`;
      assert.equal(validate(options), true, `${label}: JSON Schema`);
      assert.equal(
        runtimePreflight(options, { baseUrl }).valid,
        true,
        `${label}: runtime Preflight`,
      );
      assert.equal(
        publicPreflight(options, { baseUrl }).valid,
        true,
        `${label}: public Preflight`,
      );
      assert.doesNotThrow(
        () => validateRuntimeConfiguration(options, baseUrl),
        label,
      );
    }
  }

  for (const { name, value, schemaValid } of invalidSerializableUrlCases) {
    for (const [field, options] of configurations(value)) {
      const label = `${name} in ${field}`;
      assert.equal(
        validate(options),
        schemaValid,
        `${label}: JSON Schema lexical gate`,
      );
      assert.equal(
        runtimePreflight(options, { baseUrl }).valid,
        false,
        `${label}: runtime Preflight`,
      );
      assert.equal(
        publicPreflight(options, { baseUrl }).valid,
        false,
        `${label}: public Preflight`,
      );
      assert.throws(
        () => validateRuntimeConfiguration(options, baseUrl),
        (error) => error?.name === "PeeklingPreflightError",
        label,
      );
    }
  }
});

test("absolute HTTPS inputs do not depend on a document base URL", () => {
  const configuration = {
    character: "peek",
    atlasUrl: "https://assets.peekling.test/atlas.png",
    styles: { url: "https://assets.peekling.test/peekling.css" },
  };

  assert.equal(
    runtimePreflight(configuration, { baseUrl: "about:blank" }).valid,
    true,
  );
  assert.equal(publicPreflight(configuration).valid, true);
  assert.doesNotThrow(() =>
    validateRuntimeConfiguration(configuration, "about:blank"),
  );
});

function assertTypeShapesMatchSchema(types, schema) {
  const interfaces = parseInterfaces(types);
  const native = schema.$defs.nativeManifest;
  const normalized = schema.$defs.normalizedPack;
  const mappings = [
    ["SerializablePeeklingOptionFields", schema],
    ["PixelPoint", schema.$defs.pixelPoint],
    ["Point", schema.$defs.point],
    ["Plan", schema.$defs.plan],
    ["PlanRuleFields", schema.$defs.planRule],
    ["PlanEffect", schema.$defs.planEffect],
    ["PlanContinuousEffect", schema.$defs.planContinuousEffect],
    ["FollowPointerMotionEffect", schema.$defs.followPointerMotionEffect],
    ["HorizontalPatrolMotionEffect", schema.$defs.horizontalPatrolMotionEffect],
    ["PlanSurfaceEffect", schema.$defs.planSurfaceEffect],
    ["PlanSurfaceOrdering", schema.$defs.planSurfaceOrdering],
    ["ContentSurfaceFields", schema.$defs.contentSurface],
    ["ContentLink", schema.$defs.link],
    ["SurfaceTheme", schema.$defs.theme],
    ["RuntimeStyleAsset", schema.$defs.runtimeStyles],
    ["AccessibilityOptions", schema.$defs.accessibility],
    ["DiagnosticOptions", schema.$defs.diagnostics],
    ["NativeManifest", native],
    ["PackMetadata", native.properties.metadata],
    ["NativeAtlas", native.properties.assets.oneOf[0].properties.atlas],
    ["AdaptiveAtlases", native.properties.assets.oneOf[1].properties.atlases],
    ["AtlasVariant", schema.$defs.atlasVariant],
    ["NormalizedPack", normalized],
    ["NormalizedAtlas", normalized.properties.atlas],
    [
      "NormalizedAtlasVariant",
      normalized.properties.atlas.properties.variants.items,
    ],
    ["LocomotionCapability", schema.$defs.locomotionCapability],
    ["LocomotionKeyframe", schema.$defs.locomotionKeyframes.items],
  ];

  for (const [name, schemaNode] of mappings) {
    const shape = interfaceShape(name, interfaces);
    assert.deepEqual(
      [...shape.keys()].sort(),
      Object.keys(schemaNode.properties ?? {}).sort(),
      `${name} property names match the authoritative schema`,
    );
    assert.deepEqual(
      [...shape]
        .filter(([, optional]) => !optional)
        .map(([property]) => property)
        .sort(),
      [...(schemaNode.required ?? [])].sort(),
      `${name} required properties match the authoritative schema`,
    );
  }
}

function interfaceShape(name, interfaces, seen = new Set()) {
  if (seen.has(name)) return new Map();
  seen.add(name);
  const definition = interfaces.get(name);
  assert.ok(definition, `TypeScript reference defines ${name}`);
  const shape = new Map();
  for (const parent of definition.parents) {
    for (const [property, optional] of interfaceShape(
      parent,
      interfaces,
      seen,
    )) {
      shape.set(property, optional);
    }
  }
  for (const [property, optional] of definition.properties) {
    shape.set(property, optional);
  }
  return shape;
}

function parseInterfaces(types) {
  const interfaces = new Map();
  const startPattern =
    /(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+([^\{]+))?\s*\{/g;
  for (const match of types.matchAll(startPattern)) {
    const open = match.index + match[0].lastIndexOf("{");
    let depth = 1;
    let cursor = open + 1;
    while (cursor < types.length && depth > 0) {
      if (types[cursor] === "{") depth += 1;
      if (types[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    const body = types.slice(open + 1, cursor - 1);
    const properties = new Map();
    for (const property of body.matchAll(
      /^  (?:(?:"([^"]+)")|([A-Za-z][A-Za-z0-9]*))(\?)?:/gm,
    )) {
      properties.set(property[1] ?? property[2], !!property[3]);
    }
    const parents = (match[2] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    interfaces.set(match[1], { parents, properties });
  }
  return interfaces;
}

function inspect(value, path, seen) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (value.type === "object") {
    assert.equal(
      value.additionalProperties,
      false,
      `${path} closes additional properties`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspect(item, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    inspect(item, `${path}.${key}`, seen);
  }
}
