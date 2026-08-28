export const nullSerializableConfigurationCase = {
  name: "null options",
  configuration: null,
};

export const validSurfaceColorCases = [
  "transparent",
  "#000",
  "#fFfA",
  "#012345",
  "#89AbCdEf",
];

export const invalidSurfaceColorCases = [
  "red",
  "rgb(0 0 0)",
  "url(https://theme-probe.test/pixel.png)",
  'image-set("https://theme-probe.test/pixel.png" 1x)',
  "var(--host-color)",
  "linear-gradient(#000, #fff)",
  '@import "https://theme-probe.test/theme.css"',
  "#fff;background:red",
  "#fff{color:red}",
  "/*comment*/#fff",
  "\\75rl(https://theme-probe.test/pixel.png)",
  "ｕｒｌ(https://theme-probe.test/pixel.png)",
  "#fff\u00a0",
  "#12",
  "#12345",
  "#ggg",
];

export const validSerializableUrlCases = [
  { name: "root-relative path", value: "/assets/peek/character.json" },
  { name: "dot-relative path", value: "./assets/atlas.png" },
  { name: "parent-relative path", value: "../assets/atlas.png" },
  { name: "bare relative path", value: "assets/atlas.png" },
  { name: "relative query", value: "?density=2" },
  { name: "relative fragment", value: "#details" },
  { name: "encoded relative path", value: "assets/file%20name.png" },
  {
    name: "absolute HTTPS host",
    value: "https://assets.example/peek/character.json",
  },
  {
    name: "uppercase absolute HTTPS scheme",
    value: "HTTPS://assets.example/peek/character.json",
  },
  {
    name: "absolute HTTPS IPv4 host",
    value: "https://127.0.0.1:8443/atlas.png",
  },
  {
    name: "absolute HTTPS IPv6 host",
    value: "https://[::1]:8443/atlas.png",
  },
  {
    name: "absolute HTTPS punycode host",
    value: "https://xn--r8jz45g.xn--zckzah/atlas.png",
  },
];

export const invalidSerializableUrlCases = [
  {
    name: "non-breaking space",
    value: "/asset\u00a0file.json",
    schemaValid: false,
  },
  { name: "thin space", value: "/asset\u2009file.json", schemaValid: false },
  {
    name: "leading space",
    value: " https://assets.example/a",
    schemaValid: false,
  },
  {
    name: "trailing newline",
    value: "https://assets.example/a\n",
    schemaValid: false,
  },
  { name: "tab", value: "/asset\tfile.json", schemaValid: false },
  { name: "backslash", value: "assets\\atlas.png", schemaValid: false },
  {
    name: "absolute HTTP",
    value: "http://assets.example/a",
    schemaValid: false,
  },
  {
    name: "protocol relative",
    value: "//assets.example/a",
    schemaValid: false,
  },
  {
    name: "credentials",
    value: "https://user:pass@assets.example/a",
    schemaValid: false,
  },
  { name: "script scheme", value: "javascript:alert(1)", schemaValid: false },
  { name: "data scheme", value: "data:text/plain,peek", schemaValid: false },
  { name: "file scheme", value: "file:///tmp/peek", schemaValid: false },
  {
    name: "malformed percent escape",
    value: "/asset%zz.png",
    schemaValid: false,
  },
  {
    name: "invalid port",
    value: "https://assets.example:99999/a",
    schemaValid: true,
  },
  {
    name: "empty port",
    value: "https://assets.example:/a",
    schemaValid: true,
  },
  {
    name: "invalid IPv6 literal",
    value: "https://[gggg::1]/a",
    schemaValid: true,
  },
  {
    name: "unterminated IPv6 literal",
    value: "https://[::1/a",
    schemaValid: true,
  },
  { name: "missing host", value: "https:///a", schemaValid: true },
  {
    name: "leading-hyphen host label",
    value: "https://-bad.example/a",
    schemaValid: true,
  },
  {
    name: "trailing-hyphen host label",
    value: "https://bad-.example/a",
    schemaValid: true,
  },
  {
    name: "empty host label",
    value: "https://example..com/a",
    schemaValid: true,
  },
  { name: "short IPv4 form", value: "https://127.1/a", schemaValid: true },
  {
    name: "hexadecimal IPv4 form",
    value: "https://0x7f000001/a",
    schemaValid: true,
  },
  {
    name: "Unicode hostname",
    value: "https://例え.テスト/a",
    schemaValid: true,
  },
  {
    name: "percent-encoded hostname",
    value: "https://%65xample.com/a",
    schemaValid: true,
  },
];

export const invalidSerializableConfigurationCases = [
  {
    name: "missing Pack selection",
    configuration: {},
  },
  {
    name: "script manifest URL",
    configuration: { packUrl: "javascript:alert(1)" },
  },
  {
    name: "file atlas URL",
    configuration: {
      character: "peek",
      atlasUrl: "file:///tmp/atlas.png",
    },
  },
  {
    name: "credential-bearing stylesheet URL",
    configuration: {
      character: "peek",
      styles: { url: "https://user@example.com/peekling.css" },
    },
  },
  {
    name: "cross-origin absolute HTTP resources",
    configuration: {
      packUrl: "http://assets.example/character.json",
      atlasUrl: "http://assets.example/atlas.png",
      styles: { url: "http://assets.example/peekling.css" },
    },
  },
  {
    name: "same-origin absolute HTTP resources",
    configuration: {
      packUrl: "http://site.example/character.json",
      atlasUrl: "http://site.example/atlas.png",
      styles: { url: "http://site.example/peekling.css" },
    },
  },
  {
    name: "absolute HTTP content link",
    configuration: {
      character: "peek",
      content: {
        status: {
          bottom: {
            link: {
              label: "Details",
              href: "http://site.example/details",
            },
          },
        },
      },
    },
  },
  {
    name: "null content",
    configuration: { character: "peek", content: null },
  },
  {
    name: "null theme",
    configuration: { character: "peek", theme: null },
  },
  {
    name: "array accessibility options",
    configuration: { character: "peek", accessibility: [] },
  },
  {
    name: "array diagnostic options",
    configuration: { character: "peek", diagnostics: [] },
  },
  {
    name: "null diagnostic context",
    configuration: {
      character: "peek",
      diagnostics: { context: null },
    },
  },
  {
    name: "open position object",
    configuration: {
      character: "peek",
      position: { x: 40, y: 80, unit: "px" },
    },
  },
  {
    name: "out-of-range position",
    configuration: {
      character: "peek",
      position: { x: 100_001, y: 0 },
    },
  },
  {
    name: "baseline Event ordering",
    configuration: {
      character: "peek",
      plan: {
        baseline: {
          channels: ["surface:status"],
          surfaces: [
            {
              id: "status",
              contentId: "status",
              ordering: {
                sessionField: "sessionId",
                revisionField: "revision",
              },
            },
          ],
        },
      },
      content: { status: { bottom: "Ready" } },
    },
  },
  {
    name: "baseline without state ownership",
    configuration: {
      character: "peek",
      plan: {
        baseline: {
          channels: ["surface:status"],
          surfaces: [{ id: "status", contentId: "status" }],
        },
      },
      content: { status: { bottom: "Ready" } },
    },
  },
  {
    name: "baseline interrupt lifetime",
    configuration: {
      character: "peek",
      plan: {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
          until: { type: "duration", ms: 100 },
        },
      },
    },
  },
  {
    name: "continuous interrupt completion Event",
    configuration: {
      character: "peek",
      plan: {
        baseline: {
          channels: ["state"],
          state: { state: "idle" },
        },
        rules: [
          {
            id: "wait-for-pointer",
            when: { source: "application", event: "app.wait" },
            effect: {
              channels: ["state"],
              state: { state: "idle" },
              until: { type: "event", name: "pointer.move" },
            },
          },
        ],
      },
    },
  },
];

export const validSerializableConfigurationCases = [
  {
    name: "relative resources and closed empty settings",
    configuration: {
      packUrl: "/packs/peek/character.json",
      atlasUrl: "/packs/peek/atlas.png",
      styles: { url: "/peekling.css" },
      position: { x: -100_000, y: 100_000 },
      content: {},
      theme: {},
      accessibility: {},
      diagnostics: { context: {} },
    },
  },
  {
    name: "HTTPS resources",
    configuration: {
      packUrl: "https://assets.example/character.json",
      atlasUrl: "https://assets.example/atlas.png",
      styles: { url: "https://assets.example/peekling.css" },
    },
  },
];
