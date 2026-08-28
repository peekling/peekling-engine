import { runtimeMessage } from "./runtime-diagnostics.js";

declare const __PEEKLING_BROWSER_BUILD__: boolean;

const browserBuild =
  typeof __PEEKLING_BROWSER_BUILD__ !== "undefined" &&
  __PEEKLING_BROWSER_BUILD__;

export interface RuntimeStyleAsset {
  /** Relative or absolute HTTPS candidate when supplied by Configuration. */
  url: string;
  integrity?: string;
}

export function connectRuntimeHost(
  host: HTMLElement,
  document: Document,
  marker: string,
): void {
  if (host.ownerDocument !== document) {
    throw new Error(
      runtimeMessage(
        "root.document",
        "Peekling root was adopted into another document",
      ),
    );
  }
  const parent = document.documentElement;
  if (!parent)
    throw new Error(
      runtimeMessage(
        "root.missing",
        "Peekling document has no document element",
      ),
    );
  if (host.parentNode !== parent) parent.append(host);
  if (!host.hasAttribute(marker)) host.setAttribute(marker, "");
}

let browserDefault: RuntimeStyleAsset | undefined;

export function setBrowserStyleAsset(asset: RuntimeStyleAsset): void {
  browserDefault = Object.freeze({ ...asset });
}

export function validStyleIntegrity(
  value: unknown,
): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" &&
      /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(value))
  );
}

function defaultStyleAsset(baseUrl: string): RuntimeStyleAsset {
  if (browserBuild) {
    return { url: new URL("./peekling.css", baseUrl).href };
  }
  try {
    const url = new URL("./peekling.css", import.meta.url);
    if (url.protocol === "https:" || url.protocol === "http:") {
      return { url: url.href };
    }
  } catch {
    // The explicit Configuration hint below is stable across module loaders.
  }
  throw new TypeError(
    runtimeMessage(
      "styles.default",
      "Pass styles.url pointing to @peekling/runtime/peekling.css",
    ),
  );
}

export function resolveStyleAsset(
  configured: RuntimeStyleAsset | undefined,
  baseUrl: string,
): RuntimeStyleAsset {
  const selected = configured ?? browserDefault ?? defaultStyleAsset(baseUrl);
  const url = new URL(selected.url, baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(
      runtimeMessage("styles.url", "styles.url must resolve to HTTP or HTTPS"),
    );
  }
  if (!validStyleIntegrity(selected.integrity)) {
    throw new TypeError(
      runtimeMessage(
        "styles.integrity",
        "styles.integrity must be one SRI hash",
      ),
    );
  }
  return Object.freeze({
    url: url.href,
    ...(selected.integrity ? { integrity: selected.integrity } : {}),
  });
}

export class ShadowStyleSheet {
  readonly ready: Promise<void>;
  readonly #link: HTMLLinkElement;
  #sheet: CSSStyleSheet | undefined;
  #settled = false;
  #rejectReady: (reason: unknown) => void = () => {};

  constructor(document: Document, root: ShadowRoot, asset: RuntimeStyleAsset) {
    const link = document.createElement("link");
    this.#link = link;
    link.rel = "stylesheet";
    link.href = asset.url;
    link.crossOrigin = "anonymous";
    link.referrerPolicy = "no-referrer";
    if (asset.integrity) link.integrity = asset.integrity;
    this.ready = new Promise<void>((resolve, reject) => {
      this.#rejectReady = reject;
      const fail = (code: string, detail: string | (() => string)) => {
        if (this.#settled) return;
        this.#settled = true;
        reject(new Error(runtimeMessage(code, detail)));
      };
      link.addEventListener(
        "load",
        () => {
          if (this.#settled) return;
          const sheet = link.sheet;
          if (!sheet || typeof sheet.insertRule !== "function") {
            fail("styles.cssom", "Peekling stylesheet did not expose CSSOM");
            return;
          }
          try {
            void sheet.cssRules.length;
          } catch {
            fail(
              "styles.cors",
              "Peekling stylesheet requires same-origin or CORS-enabled delivery",
            );
            return;
          }
          this.#sheet = sheet;
          this.#settled = true;
          resolve();
        },
        { once: true },
      );
      link.addEventListener(
        "error",
        () =>
          fail(
            "styles.load",
            () => `Peekling stylesheet failed to load: ${asset.url}`,
          ),
        { once: true },
      );
    });
    void this.ready.catch(() => {});
    root.append(link);
  }

  addRule(selector: string): CSSStyleDeclaration {
    if (!this.#sheet)
      throw new Error(
        runtimeMessage("styles.pending", "Peekling stylesheet is not ready"),
      );
    const index = this.#sheet.cssRules.length;
    this.#sheet.insertRule(`${selector}{}`, index);
    const rule = this.#sheet.cssRules[index] as CSSStyleRule | undefined;
    if (!rule?.style) {
      throw new Error(
        runtimeMessage(
          "styles.rule",
          "Peekling stylesheet rule creation failed",
        ),
      );
    }
    return rule.style;
  }

  removeRule(style: CSSStyleDeclaration): void {
    const sheet = this.#sheet;
    if (!sheet) return;
    for (let index = sheet.cssRules.length - 1; index >= 0; index--) {
      const rule = sheet.cssRules[index] as CSSStyleRule | undefined;
      if (rule?.style === style) {
        sheet.deleteRule(index);
        return;
      }
    }
  }

  destroy(): void {
    if (!this.#settled) {
      this.#settled = true;
      this.#rejectReady(
        new DOMException(
          runtimeMessage(
            "styles.cancelled",
            "Peekling stylesheet load cancelled",
          ),
          "AbortError",
        ),
      );
    }
    this.#link.remove();
    this.#sheet = undefined;
  }
}
