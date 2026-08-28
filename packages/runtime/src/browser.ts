import { setBrowserStyleAsset } from "./styles.js";
import {
  definePeeklingElement,
  reportBrowserCollision,
} from "./web-component.js";
import { hidePeekling, isPeeklingHidden, showPeekling } from "./visibility.js";
import { hatch } from "./runtime.js";

declare const __PEEKLING_CSS_INTEGRITY__: string;

const browserCssIntegrity =
  typeof __PEEKLING_CSS_INTEGRITY__ === "string" && __PEEKLING_CSS_INTEGRITY__
    ? __PEEKLING_CSS_INTEGRITY__
    : undefined;

const browserScript = globalThis.document?.currentScript as
  HTMLScriptElement | null | undefined;
if (browserScript?.src) {
  setBrowserStyleAsset({
    url: new URL("./peekling.css", browserScript.src).href,
    ...(browserCssIntegrity ? { integrity: browserCssIntegrity } : {}),
  });
}

const api = Object.freeze({
  hatch,
  visibility: Object.freeze({
    hide: hidePeekling,
    show: showPeekling,
    isHidden: (window = globalThis.window) => Boolean(isPeeklingHidden(window)),
  }),
});

try {
  if (Reflect.has(globalThis, "Peekling")) {
    reportBrowserCollision("Peekling");
  } else {
    Object.defineProperty(globalThis, "Peekling", {
      configurable: true,
      value: api,
      writable: false,
    });
  }
} catch {
  reportBrowserCollision("Peekling");
}

definePeeklingElement();
