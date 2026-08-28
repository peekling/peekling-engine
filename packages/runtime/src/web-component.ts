import {
  PeeklingRuntime,
  type PeeklingInstance,
  type PeeklingOptions,
} from "./runtime.js";
import type {
  Plan,
  DiagnosticRecord,
  EmitResult,
  HostBindings,
  HostContent,
  OverrideInput,
  OverrideHandle,
  SurfaceTheme,
} from "./types.js";
import { runtimeMessage } from "./runtime-diagnostics.js";
import { OwnDataError, snapshotConfiguration } from "./own-data.js";

export const PEEKLING_ELEMENT_TAG = "peekling-character";
let disconnectedRequestId = 0;
let supportedElement: CustomElementConstructor | undefined;

export function reportBrowserCollision(name: string): void {
  try {
    globalThis.dispatchEvent(
      new CustomEvent("peekling:collision", {
        detail: name,
      }),
    );
  } catch {}
}

export interface PeeklingElement extends HTMLElement {
  options: PeeklingOptions;
  plan?: Plan;
  content?: HostContent;
  bindings?: HostBindings;
  theme?: SurfaceTheme;
  styles?: PeeklingOptions["styles"];
  accessibility?: PeeklingOptions["accessibility"];
  diagnostics?: PeeklingOptions["diagnostics"];
  logger?: (record: Readonly<DiagnosticRecord>) => void;
  readonly instance?: PeeklingInstance;
  readonly ready: Promise<PeeklingInstance>;
  emit(name: string, payload?: unknown): EmitResult;
  override(value: OverrideInput): OverrideHandle;
  pause(): void;
  resume(): void;
}

declare global {
  interface HTMLElementTagNameMap {
    "peekling-character": PeeklingElement;
  }
  interface WindowEventMap {
    "peekling:collision": CustomEvent<"Peekling" | typeof PEEKLING_ELEMENT_TAG>;
  }
}

type ReadyState = [
  Promise<PeeklingInstance>,
  (value: PeeklingInstance) => void,
  (reason: unknown) => void,
];

function readyState(): ReadyState {
  let resolve!: (value: PeeklingInstance) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<PeeklingInstance>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  void promise.catch(() => {});
  return [promise, resolve, reject];
}

export function definePeeklingElement(): void {
  try {
    const registry = globalThis.customElements;
    const Base = globalThis.HTMLElement;
    if (!registry || !Base) return;
    const existing = registry.get(PEEKLING_ELEMENT_TAG);
    if (existing) {
      if (existing !== supportedElement) {
        reportBrowserCollision(PEEKLING_ELEMENT_TAG);
      }
      return;
    }
    class PeeklingElement extends Base {
      static observedAttributes = [
        "character",
        "pack-url",
        "name",
        "styles-url",
        "styles-integrity",
      ];
      static {
        for (const key of [
          "plan",
          "content",
          "bindings",
          "theme",
          "styles",
          "accessibility",
          "diagnostics",
          "logger",
        ] as const) {
          Object.defineProperty(this.prototype, key, {
            configurable: true,
            get() {
              return this.#overrides[key];
            },
            set(value) {
              this.#set(key, value);
            },
          });
        }
      }
      #instance: PeeklingRuntime | undefined;
      #options: unknown = Object.create(null);
      #optionsError: OwnDataError | undefined;
      #overrides = Object.create(null) as PeeklingOptions;
      #scheduled = false;
      #mountedOnce = false;
      #generation = 0;
      #ready = readyState();
      readonly #pageShow = (event: Event) => {
        if ((event as PageTransitionEvent).persisted) this.#remount();
      };

      /** Full JavaScript API configuration. Scalar attributes override matching fields. */
      get options(): PeeklingOptions {
        return this.#options as PeeklingOptions;
      }

      set options(value: PeeklingOptions) {
        try {
          this.#options = snapshotConfiguration(value);
          this.#optionsError = undefined;
        } catch (error) {
          this.#options = Object.create(null);
          this.#optionsError = error as OwnDataError;
        }
        this.#remount();
      }

      get instance(): PeeklingInstance | undefined {
        return this.#instance;
      }

      /** Resolves when the current connected mount is fully initialized. */
      get ready(): Promise<PeeklingInstance> {
        return this.#ready[0];
      }

      emit(name: string, payload?: unknown): EmitResult {
        return (
          this.#instance?.emit(name, payload) ?? {
            accepted: false,
            reason: "not-ready",
          }
        );
      }

      override(value: OverrideInput): OverrideHandle {
        if (!this.#instance) {
          const id = `override:disconnected:${++disconnectedRequestId}`;
          return {
            id,
            status: "rejected",
            finished: Promise.resolve({ id, reason: "rejected" }),
            cancel: () => {},
          };
        }
        return this.#instance.override(value);
      }

      pause(): void {
        this.#instance?.pause();
      }

      resume(): void {
        this.#instance?.resume();
      }

      connectedCallback(): void {
        globalThis.addEventListener?.("pageshow", this.#pageShow);
        this.#remount();
      }

      attributeChangedCallback(name: string): void {
        const attribute = this.getAttribute("name");
        if (
          name === "name" &&
          this.#instance &&
          this.#instance.updateComponentName(
            attribute === null
              ? (this.#options as PeeklingOptions).name
              : attribute || true,
          )
        ) {
          return;
        }
        this.#remount();
      }

      disconnectedCallback(): void {
        globalThis.removeEventListener?.("pageshow", this.#pageShow);
        this.#generation += 1;
        this.#scheduled = false;
        this.#ready[2](
          new DOMException(
            runtimeMessage("element.disconnected", "Element disconnected"),
            "AbortError",
          ),
        );
        this.#instance?.destroy();
        this.#instance = undefined;
      }

      #set<K extends keyof PeeklingOptions>(
        key: K,
        value: PeeklingOptions[K],
      ): void {
        if (value === undefined) delete this.#overrides[key];
        else this.#overrides[key] = value;
        this.#remount();
      }

      #remount(): void {
        if (!this.isConnected || this.#scheduled) return;
        this.#scheduled = true;
        const generation = ++this.#generation;
        if (this.#mountedOnce) {
          this.#ready[2](
            new DOMException(
              runtimeMessage("element.remounted", "Element remounted"),
              "AbortError",
            ),
          );
          this.#ready = readyState();
        } else this.#mountedOnce = true;
        queueMicrotask(() => {
          if (generation !== this.#generation) return;
          this.#scheduled = false;
          if (!this.isConnected) return;
          this.#instance?.destroy();
          this.#instance = undefined;
          void this.#mount(generation);
        });
      }

      async #mount(generation: number): Promise<void> {
        try {
          if (this.#optionsError) throw this.#optionsError;
          if (
            !this.#options ||
            typeof this.#options !== "object" ||
            Array.isArray(this.#options)
          ) {
            throw new OwnDataError(
              "$",
              runtimeMessage(
                "data.plain",
                "must use this realm's Object prototype or a null prototype",
              ),
            );
          }
          const configured = Object.create(null) as PeeklingOptions;
          for (const source of [
            this.#options as PeeklingOptions,
            this.#overrides,
          ]) {
            for (const key in source) {
              configured[key as keyof PeeklingOptions] = source[
                key as keyof PeeklingOptions
              ] as never;
            }
          }
          const character = this.getAttribute("character");
          if (character !== null) configured.character = character;
          const packUrl = this.getAttribute("pack-url");
          if (packUrl !== null) configured.packUrl = packUrl;
          const name = this.getAttribute("name");
          if (name !== null) configured.name = name || true;
          const stylesUrl = this.getAttribute("styles-url");
          if (stylesUrl !== null) {
            const stylesIntegrity = this.getAttribute("styles-integrity");
            configured.styles = stylesIntegrity
              ? { url: stylesUrl, integrity: stylesIntegrity }
              : { url: stylesUrl };
          }
          const instance = PeeklingRuntime.hatch(configured);
          this.#instance = instance;
          await instance.ready;
          if (generation !== this.#generation || !this.isConnected) {
            instance.destroy();
            return;
          }
          this.#ready[1](instance);
        } catch (error) {
          if (generation !== this.#generation) return;
          this.#instance?.destroy();
          this.#instance = undefined;
          this.#ready[2](error);
        }
      }
    }
    registry.define(PEEKLING_ELEMENT_TAG, PeeklingElement);
    supportedElement = PeeklingElement;
  } catch {
    reportBrowserCollision(PEEKLING_ELEMENT_TAG);
  }
}
