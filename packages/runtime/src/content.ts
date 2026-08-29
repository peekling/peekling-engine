import {
  CONTENT_REGIONS,
  type ContentRegion,
  type HostContent,
  type HostContentItem,
  type HostContentPrimitive,
  type HostBindings,
  type HostContentSurface,
  type HostSurfaceMountResult,
  type JsonValue,
  type Point,
  type SurfaceTheme,
} from "./types.js";
import { isHttpPath, NAME_PATTERN } from "./contracts.js";
import { validateEventPayload } from "./events.js";
import { runtimeMessage } from "./runtime-diagnostics.js";
import {
  connectRuntimeHost,
  resolveStyleAsset,
  ShadowStyleSheet,
  type RuntimeStyleAsset,
} from "./styles.js";

export function validateHostContent(
  input: HostContent | undefined,
  baseUrl: string,
): HostContent {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(
      runtimeMessage("content.object", () => "content must be an object"),
    );
  }
  const entries = Object.entries(input);
  if (entries.length > 32)
    throw new TypeError(
      runtimeMessage("content.limit", () => "content exceeds 32 items"),
    );
  const result: Record<string, HostContentItem> = {};
  for (const [id, item] of entries) {
    if (!NAME_PATTERN.test(id))
      throw new TypeError(
        runtimeMessage("content.id", () => `Invalid content id: ${id}`),
      );
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(
        runtimeMessage("content.item", () => `Invalid content item: ${id}`),
      );
    }
    closed(item, CONTENT_REGIONS, id);
    const normalized: Partial<Record<ContentRegion, HostContentPrimitive>> = {};
    for (const region of CONTENT_REGIONS) {
      const surface = item[region];
      if (surface !== undefined) {
        normalized[region] = validateSurface(
          surface,
          baseUrl,
          `${id}.${region}`,
        );
      }
    }
    if (!Object.keys(normalized).length) {
      throw new TypeError(
        runtimeMessage("content.empty", () => `Content item is empty: ${id}`),
      );
    }
    result[id] = normalized as HostContentItem;
  }
  return result;
}

function validateSurface(
  value: HostContentPrimitive,
  baseUrl: string,
  path: string,
): HostContentPrimitive {
  if (typeof value === "string") return boundedText(value, 500, path)!;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      runtimeMessage(
        "content.surface",
        () => `Invalid content surface: ${path}`,
      ),
    );
  }
  closed(value, ["title", "text", "link", "mountId", "announce"], path);
  const title = boundedText(value.title, 120, `${path}.title`);
  const contentText = boundedText(value.text, 500, `${path}.text`);
  if (value.announce !== undefined && typeof value.announce !== "boolean") {
    throw new TypeError(
      runtimeMessage(
        "content.announce",
        () => `Invalid announce flag: ${path}.announce`,
      ),
    );
  }
  if (
    value.mountId !== undefined &&
    (typeof value.mountId !== "string" || !NAME_PATTERN.test(value.mountId))
  ) {
    throw new TypeError(
      runtimeMessage(
        "content.binding",
        () => `Invalid binding: ${path}.mountId`,
      ),
    );
  }
  let link: HostContentSurface["link"];
  if (value.link !== undefined) {
    if (value.link && typeof value.link === "object") {
      closed(value.link, ["label", "href"], `${path}.link`);
    }
    if (
      !value.link ||
      typeof value.link.label !== "string" ||
      typeof value.link.href !== "string" ||
      !isHttpPath(value.link.href, baseUrl)
    ) {
      throw new TypeError(
        runtimeMessage(
          "content.link",
          () =>
            `Invalid content link protocol or credentials: ${path}.link. Use a relative path or absolute HTTPS URL`,
        ),
      );
    }
    const href = new URL(value.link.href, baseUrl);
    link = {
      label: boundedText(value.link.label, 120, `${path}.link.label`)!,
      href: href.href,
    };
  }
  if (!title && !contentText && !link && !value.mountId) {
    throw new TypeError(
      runtimeMessage("content.empty", () => `Content is empty: ${path}`),
    );
  }
  return {
    ...(title ? { title } : {}),
    ...(contentText ? { text: contentText } : {}),
    ...(link ? { link } : {}),
    ...(value.mountId ? { mountId: value.mountId } : {}),
    ...(value.announce === true ? { announce: true } : {}),
  } as HostContentSurface;
}

function closed(value: object, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new TypeError(
        runtimeMessage("content.field", () => `Unknown field: ${path}.${key}`),
      );
  }
}

function boundedText(
  value: string | undefined,
  maximum: number,
  path: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(
      runtimeMessage("content.text", () => `Invalid content text: ${path}`),
    );
  }
  return value;
}

export function validateContentReferences(
  ids: readonly (string | undefined)[],
  content: HostContent,
): void {
  for (const id of ids) {
    if (id && !Object.hasOwn(content, id))
      throw new TypeError(
        runtimeMessage("content.reference", () => `Unknown contentId: ${id}`),
      );
  }
}

export function placeContentRegion(
  region: ContentRegion,
  position: Point,
  viewport: { width: number; height: number },
  character: { width: number; height: number },
  surface: { width: number; height: number },
): Point {
  const margin = 8;
  const gap = 12;
  const above = position.y - character.height / 2 - gap - surface.height;
  const below = position.y + character.height / 2 + gap;
  const left = position.x - character.width / 2 - gap - surface.width;
  const center = position.x - surface.width / 2;
  const right = position.x + character.width / 2 + gap;
  const topX =
    region === "top-left" ? left : region === "top-right" ? right : center;
  const wantsBottom = region === "bottom";
  const preferredY = wantsBottom ? below : above;
  const alternateY = wantsBottom ? above : below;
  return {
    x: clamp(topX, margin, viewport.width - surface.width - margin),
    y: clamp(
      preferredY >= margin &&
        preferredY + surface.height <= viewport.height - margin
        ? preferredY
        : alternateY,
      margin,
      viewport.height - surface.height - margin,
    ),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, Math.max(minimum, maximum)));
}

interface SurfaceElements {
  key: string;
  surfaceId: string;
  contentId: string;
  region: ContentRegion;
  host: HTMLElement;
  title: HTMLElement;
  text: HTMLParagraphElement;
  link: HTMLAnchorElement;
  custom: HTMLElement;
  mounted: MountedSurface | undefined;
  renderKey: string;
  failedKey: string;
  seen: number;
  measureDirty: boolean;
  measuredWidth: number;
  measuredHeight: number;
  left: string;
  top: string;
  primitive?: HostContentPrimitive;
  item?: HostContentSurface;
  positionStyle: CSSStyleDeclaration;
}

interface MountedSurface {
  mountId: string;
  abort: AbortController;
  root: HTMLElement;
  result: SafeMountResult | undefined;
  data: JsonValue | undefined;
  pendingUpdate: boolean;
  updating: boolean;
  key: string;
}

interface SafeMountResult {
  cleanup: () => void | PromiseLike<void>;
  update?: (data: JsonValue | undefined) => void | PromiseLike<void>;
}

export interface ContentSelection {
  id: string;
  contentId: string;
  data?: JsonValue;
  key: string;
}

export interface ContentRendererOptions {
  diagnostic?: (message: string) => void;
  bindings?: HostBindings;
  theme?: SurfaceTheme;
  announce?: boolean;
  label?: string;
  emit?: (name: string, payload?: unknown) => import("./types.js").EmitResult;
  wake?: () => void;
  styles?: RuntimeStyleAsset;
}

export class ContentRenderer {
  readonly ready: Promise<void>;
  readonly #document: Document;
  readonly #host: HTMLElement;
  readonly #root: ShadowRoot;
  readonly #surfaces = new Map<string, SurfaceElements>();
  readonly #origin: string;
  readonly #diagnostic: (message: string) => void;
  readonly #bindings: HostBindings;
  readonly #announce: boolean;
  readonly #emit: NonNullable<ContentRendererOptions["emit"]>;
  readonly #wake: NonNullable<ContentRendererOptions["wake"]>;
  readonly #styles: ShadowStyleSheet;
  readonly #label: string;
  #positionId = 0;
  #selectionGeneration = 0;
  #placementDirty = true;
  #positionX = Number.NaN;
  #positionY = Number.NaN;
  #viewportWidth = Number.NaN;
  #viewportHeight = Number.NaN;
  #characterWidth = Number.NaN;
  #characterHeight = Number.NaN;
  #name: string | undefined;
  #nameSelection: ContentSelection | undefined;
  #nameItem: HostContentItem | undefined;
  #userHidden = false;
  #hasVisibleSurface = false;
  #destroyed = false;

  constructor(document: Document, options: ContentRendererOptions = {}) {
    this.#document = document;
    this.#origin = new URL(
      document.baseURI ??
        globalThis.location?.href ??
        "https://peekling.invalid/",
    ).origin;
    this.#diagnostic = options.diagnostic ?? (() => {});
    this.#bindings = options.bindings ?? {};
    this.#announce = options.announce === true;
    this.#emit =
      options.emit ??
      (() => ({ accepted: false, reason: "not-ready" as const }));
    this.#wake = options.wake ?? (() => {});
    this.#host = document.createElement("aside");
    this.#host.hidden = true;
    this.#host.dataset.peeklingContent = "";
    this.#label = options.label ?? "Peekling content";
    this.#host.setAttribute("aria-label", this.#label);
    this.#root = this.#host.attachShadow({ mode: "closed" });
    this.#styles = new ShadowStyleSheet(
      document,
      this.#root,
      options.styles ??
        resolveStyleAsset(
          undefined,
          document.baseURI ?? "https://peekling.invalid/",
        ),
    );
    this.ready = this.#styles.ready.then(() => {
      if (this.#destroyed) return;
      applyTheme(this.#styles.addRule(":host"), options.theme);
    });
    void this.ready.catch(() => {});
    this.#repair();
  }

  renderSurfaces(
    selections: readonly ContentSelection[],
    content: HostContent,
    position: Point,
    viewport: { width: number; height: number },
    character: { width: number; height: number },
    name?: string,
  ): void {
    if (this.#destroyed) return;
    this.#repair();
    if (this.#destroyed) return;
    this.#selectionGeneration += 1;
    if (this.#selectionGeneration >= Number.MAX_SAFE_INTEGER) {
      this.#selectionGeneration = 1;
      for (const surface of this.#surfaces.values()) surface.seen = 0;
    }
    const generation = this.#selectionGeneration;
    for (const selection of selections) {
      if (!Object.hasOwn(content, selection.contentId)) continue;
      this.#select(selection, content[selection.contentId]!, generation);
      if (this.#destroyed) return;
    }
    if (name) {
      if (name !== this.#name) {
        this.#name = name;
        this.#nameSelection = {
          id: "peekling:name",
          contentId: "peekling:name",
          key: `peekling:name:${name}`,
        };
        this.#nameItem = { bottom: name };
      }
      this.#select(this.#nameSelection!, this.#nameItem!, generation);
      if (this.#destroyed) return;
    } else {
      this.#name = undefined;
      this.#nameSelection = undefined;
      this.#nameItem = undefined;
    }
    for (const surface of this.#surfaces.values()) {
      if (surface.seen !== generation) this.#removeSurface(surface);
      if (this.#destroyed) return;
    }

    let visible = false;
    for (const surface of this.#surfaces.values()) {
      if (!surface.host.hidden) {
        visible = true;
        break;
      }
    }
    this.#hasVisibleSurface = visible;
    const hidden = this.#userHidden || !visible;
    if (this.#host.hidden !== hidden) this.#host.hidden = hidden;

    const viewportChanged =
      viewport.width !== this.#viewportWidth ||
      viewport.height !== this.#viewportHeight;
    const placementChanged =
      viewportChanged ||
      position.x !== this.#positionX ||
      position.y !== this.#positionY ||
      character.width !== this.#characterWidth ||
      character.height !== this.#characterHeight;
    this.#positionX = position.x;
    this.#positionY = position.y;
    this.#viewportWidth = viewport.width;
    this.#viewportHeight = viewport.height;
    this.#characterWidth = character.width;
    this.#characterHeight = character.height;
    if (viewportChanged) {
      for (const surface of this.#surfaces.values()) {
        if (!surface.host.hidden) surface.measureDirty = true;
      }
    }
    if (placementChanged) this.#placementDirty = true;

    for (const surface of this.#surfaces.values()) {
      if (surface.host.hidden || !surface.measureDirty) continue;
      const rect = surface.host.getBoundingClientRect();
      if (this.#destroyed) return;
      surface.measuredWidth = rect.width;
      surface.measuredHeight = rect.height;
      surface.measureDirty = false;
      this.#placementDirty = true;
    }

    if (this.#placementDirty) {
      let topLeftOffset = 0;
      let topCenterOffset = 0;
      let topRightOffset = 0;
      let bottomOffset = 0;
      const surfaces = [...this.#surfaces.values()].sort((left, right) =>
        left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
      );
      for (const surface of surfaces) {
        if (surface.host.hidden) continue;
        let offset: number;
        switch (surface.region) {
          case "top-left":
            offset = topLeftOffset;
            topLeftOffset += surface.measuredHeight + 8;
            break;
          case "top-center":
            offset = topCenterOffset;
            topCenterOffset += surface.measuredHeight + 8;
            break;
          case "top-right":
            offset = topRightOffset;
            topRightOffset += surface.measuredHeight + 8;
            break;
          case "bottom":
            offset = bottomOffset;
            bottomOffset += surface.measuredHeight + 8;
            break;
        }
        const point = placeContentRegion(
          surface.region,
          position,
          viewport,
          character,
          {
            width: surface.measuredWidth,
            height: surface.measuredHeight,
          },
        );
        const left = `${point.x}px`;
        const top = `${clamp(
          point.y + offset,
          8,
          viewport.height - surface.measuredHeight - 8,
        )}px`;
        if (surface.left !== left) {
          surface.positionStyle.left = left;
          if (this.#destroyed) return;
          surface.left = left;
        }
        if (surface.top !== top) {
          surface.positionStyle.top = top;
          if (this.#destroyed) return;
          surface.top = top;
        }
      }
      this.#placementDirty = false;
    }
  }

  setUserHidden(hidden: boolean): boolean {
    if (this.#destroyed) return false;
    const wasHidden = this.#userHidden;
    this.#userHidden = hidden;
    this.#host.hidden = hidden || !this.#hasVisibleSurface;
    if (wasHidden && !hidden && !this.#host.hidden) {
      for (const surface of this.#surfaces.values()) {
        if (!surface.host.hidden) surface.measureDirty = true;
      }
      this.#placementDirty = true;
      this.#wake();
    }
    return !this.#userHidden;
  }

  toggleUserHidden(): boolean {
    return this.setUserHidden(!this.#userHidden);
  }

  get userHidden(): boolean {
    return this.#userHidden;
  }

  #select(
    selection: ContentSelection,
    item: HostContentItem,
    generation: number,
  ): void {
    for (const region of CONTENT_REGIONS) {
      const primitive = item[region];
      if (primitive === undefined) continue;
      const key = `${selection.id}\0${region}`;
      const surface =
        this.#surfaces.get(key) ??
        this.#createSurface(key, selection.id, selection.contentId, region);
      surface.seen = generation;
      if (surface.contentId !== selection.contentId) {
        surface.contentId = selection.contentId;
        this.#invalidateSurface(surface);
      }
      this.#apply(surface, primitive, selection);
      if (this.#destroyed) return;
    }
  }

  #invalidateSurface(surface: SurfaceElements, wake = false): void {
    surface.measureDirty = true;
    this.#placementDirty = true;
    if (wake && !this.#destroyed) this.#wake();
  }

  #setHidden(surface: SurfaceElements, hidden: boolean): void {
    if (surface.host.hidden === hidden) return;
    surface.host.hidden = hidden;
    this.#placementDirty = true;
    if (!hidden) surface.measureDirty = true;
  }

  #createSurface(
    key: string,
    surfaceId: string,
    contentId: string,
    region: ContentRegion,
  ): SurfaceElements {
    const host = this.#document.createElement("section");
    const positionClass = `peekling-position-${++this.#positionId}`;
    host.className = `surface ${region} ${positionClass}`;
    host.hidden = true;
    host.setAttribute("part", `surface ${region}`);
    host.dataset.peeklingSurface = surfaceId;
    const title = this.#document.createElement("strong");
    title.className = "title";
    const text = this.#document.createElement("p");
    const link = this.#document.createElement("a");
    const custom = this.#document.createElement("div");
    custom.dataset.peeklingMount = "";
    host.append(title, text, link, custom);
    this.#root.append(host);
    const surface = {
      key,
      surfaceId,
      contentId,
      region,
      host,
      title,
      text,
      link,
      custom,
      mounted: undefined,
      renderKey: "",
      failedKey: "",
      seen: 0,
      measureDirty: true,
      measuredWidth: 0,
      measuredHeight: 0,
      left: "",
      top: "",
      positionStyle: this.#styles.addRule(`.${positionClass}`),
    };
    this.#surfaces.set(key, surface);
    this.#placementDirty = true;
    return surface;
  }

  #apply(
    elements: SurfaceElements,
    primitive: HostContentPrimitive,
    selection: ContentSelection,
  ): void {
    if (this.#destroyed) return;
    if (elements.primitive !== primitive) {
      elements.primitive = primitive;
      elements.item =
        typeof primitive === "string" ? { text: primitive } : primitive;
      const item = elements.item;
      this.#invalidateSurface(elements);
      elements.title.textContent = item.title ?? "";
      elements.title.hidden = !!item.mountId || !item.title;
      elements.text.textContent = item.text ?? "";
      elements.text.hidden = !!item.mountId || !item.text;
      elements.link.hidden = !!item.mountId || !item.link;
      if (!item.mountId && item.link) {
        elements.link.textContent = item.link.label;
        elements.link.href = item.link.href;
        if (new URL(item.link.href).origin !== this.#origin) {
          elements.link.target = "_blank";
          elements.link.rel = "noopener noreferrer";
        } else {
          elements.link.removeAttribute("target");
          elements.link.removeAttribute("rel");
        }
      } else {
        elements.link.textContent = "";
        elements.link.removeAttribute("href");
        elements.link.removeAttribute("target");
        elements.link.removeAttribute("rel");
      }
      if (item.announce || this.#announce) {
        elements.host.setAttribute("aria-live", "polite");
        elements.host.setAttribute("aria-atomic", "true");
      } else {
        elements.host.removeAttribute("aria-live");
        elements.host.removeAttribute("aria-atomic");
      }
    }
    const item = elements.item!;
    if (item.mountId) {
      const desiredKey = `${item.mountId}\0${selection.key}`;
      if (elements.failedKey === desiredKey) {
        this.#setHidden(elements, true);
        return;
      }
      if (elements.failedKey) elements.failedKey = "";
      this.#mount(elements, item.mountId, selection);
    } else {
      elements.failedKey = "";
      this.#releaseMount(elements);
    }
    if (this.#destroyed) return;
    this.#setHidden(elements, false);
  }

  #mount(
    surface: SurfaceElements,
    mountId: string,
    selection: ContentSelection,
  ): void {
    if (this.#destroyed) return;
    const renderKey = `${mountId}\0${selection.key}`;
    if (
      surface.mounted?.mountId === mountId &&
      surface.renderKey === renderKey
    ) {
      return;
    }
    let data: JsonValue | undefined;
    try {
      data = validateEventPayload(selection.data);
    } catch {
      this.#failSurface(surface, "data-failed", renderKey);
      return;
    }
    if (surface.mounted?.mountId === mountId) {
      surface.renderKey = renderKey;
      surface.mounted.data = data;
      if (surface.mounted.result?.update) {
        this.#updateMount(surface, surface.mounted, data);
        return;
      }
      if (!surface.mounted.result) {
        surface.mounted.pendingUpdate = true;
        surface.mounted.key = selection.key;
        return;
      }
      this.#releaseMount(surface);
    } else {
      this.#releaseMount(surface);
    }
    if (this.#destroyed) return;
    const mounts = this.#bindings.mounts;
    const mount =
      mounts && Object.hasOwn(mounts, mountId) ? mounts[mountId] : undefined;
    if (!mount) {
      this.#failSurface(surface, "mount-binding-is-missing", renderKey);
      return;
    }
    const abort = new AbortController();
    const root = this.#document.createElement("div");
    const mounted: MountedSurface = {
      mountId,
      abort,
      root,
      result: undefined,
      data,
      pendingUpdate: false,
      updating: false,
      key: selection.key,
    };
    surface.mounted = mounted;
    surface.renderKey = renderKey;
    surface.custom.replaceChildren(root);
    this.#invalidateSurface(surface);
    let result: HostSurfaceMountResult | PromiseLike<HostSurfaceMountResult>;
    try {
      result = mount(
        Object.freeze({
          surfaceId: surface.surfaceId,
          contentId: surface.contentId,
          region: surface.region,
          root,
          ...(data === undefined ? {} : { data }),
          signal: abort.signal,
          emit: this.#emit,
        }),
      );
    } catch {
      this.#failSurface(surface, "mount-failed", renderKey);
      return;
    }
    void Promise.resolve(result).then(
      (controller) => {
        const safeController = snapshotMountResult(controller);
        if (
          this.#destroyed ||
          surface.mounted !== mounted ||
          abort.signal.aborted
        ) {
          if (safeController) this.#cleanupResult(safeController, surface);
          return;
        }
        if (!safeController) {
          this.#failSurface(surface, "mount-failed", renderKey);
          return;
        }
        mounted.result = safeController;
        this.#invalidateSurface(surface, true);
        if (mounted.pendingUpdate) {
          mounted.pendingUpdate = false;
          if (safeController.update) {
            this.#updateMount(surface, mounted, mounted.data);
          } else {
            const latest = {
              id: surface.surfaceId,
              contentId: surface.contentId,
              ...(mounted.data === undefined ? {} : { data: mounted.data }),
              key: mounted.key,
            };
            this.#releaseMount(surface);
            this.#mount(surface, mountId, latest);
          }
        }
      },
      () => {
        if (
          !this.#destroyed &&
          surface.mounted === mounted &&
          !abort.signal.aborted
        ) {
          this.#failSurface(surface, "mount-failed", renderKey);
        }
      },
    );
  }

  #updateMount(
    surface: SurfaceElements,
    mounted: MountedSurface,
    data: JsonValue | undefined,
  ): void {
    if (this.#destroyed) return;
    const update = mounted.result?.update;
    if (!update) return;
    if (mounted.updating) {
      mounted.pendingUpdate = true;
      return;
    }
    mounted.updating = true;
    this.#invalidateSurface(surface);
    try {
      const pending = update(data);
      void Promise.resolve(pending).then(
        () => {
          if (this.#destroyed || surface.mounted !== mounted) return;
          mounted.updating = false;
          this.#invalidateSurface(surface, true);
          if (mounted.pendingUpdate) {
            mounted.pendingUpdate = false;
            this.#updateMount(surface, mounted, mounted.data);
          }
        },
        () => {
          if (!this.#destroyed && surface.mounted === mounted) {
            this.#failSurface(surface, "update-failed", surface.renderKey);
          }
        },
      );
    } catch {
      if (!this.#destroyed && surface.mounted === mounted) {
        this.#failSurface(surface, "update-failed", surface.renderKey);
      }
    }
  }

  #failSurface(
    surface: SurfaceElements,
    reason: string,
    failedKey = surface.renderKey,
  ): void {
    if (this.#destroyed) return;
    this.#diagnostic(
      runtimeMessage(
        `content.${reason}`,
        () =>
          `Content ${reason.replaceAll("-", " ")} at content.${surface.contentId}.${surface.region}`,
      ),
    );
    if (this.#destroyed) return;
    this.#releaseMount(surface);
    if (this.#destroyed) return;
    surface.failedKey = failedKey;
    this.#setHidden(surface, true);
  }

  #releaseMount(surface: SurfaceElements): void {
    const mounted = surface.mounted;
    surface.mounted = undefined;
    surface.renderKey = "";
    if (!mounted) return;
    mounted.abort.abort();
    if (mounted.result) this.#cleanupResult(mounted.result, surface);
    mounted.root.remove();
    surface.custom.replaceChildren();
    this.#invalidateSurface(surface);
  }

  #cleanupResult(result: SafeMountResult, surface: SurfaceElements): void {
    try {
      const pending = result.cleanup();
      void Promise.resolve(pending).catch(() =>
        this.#diagnostic(
          runtimeMessage(
            "content.cleanup-failed",
            () =>
              `Content cleanup failed at content.${surface.contentId}.${surface.region}`,
          ),
        ),
      );
    } catch {
      this.#diagnostic(
        runtimeMessage(
          "content.cleanup-failed",
          () =>
            `Content cleanup failed at content.${surface.contentId}.${surface.region}`,
        ),
      );
    }
  }

  #removeSurface(surface: SurfaceElements): void {
    this.#releaseMount(surface);
    if (this.#destroyed) return;
    this.#destroySurface(surface);
  }

  #destroySurface(surface: SurfaceElements): void {
    if (surface.mounted) this.#releaseMount(surface);
    this.#styles.removeRule(surface.positionStyle);
    surface.host.remove();
    this.#surfaces.delete(surface.key);
    this.#placementDirty = true;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const surface of [...this.#surfaces.values()]) {
      this.#destroySurface(surface);
    }
    this.#styles.destroy();
    this.#host.remove();
  }

  #repair(): void {
    if (this.#destroyed) return;
    const hostRepaired =
      this.#host.parentNode !== this.#document.documentElement ||
      !this.#host.hasAttribute("data-peekling-content");
    connectRuntimeHost(this.#host, this.#document, "data-peekling-content");
    if (this.#destroyed) return;
    if (this.#root.host !== this.#host)
      throw new Error(
        runtimeMessage(
          "content.root",
          () => "Peekling content root structure was changed",
        ),
      );
    if (this.#host.getAttribute("aria-label") !== this.#label)
      this.#host.setAttribute("aria-label", this.#label);
    for (const surface of this.#surfaces.values()) {
      if (hostRepaired) this.#invalidateSurface(surface);
      if (surface.host.ownerDocument !== this.#document)
        throw new Error(
          runtimeMessage(
            "content.document",
            () => "Peekling surface was adopted into another document",
          ),
        );
      if (surface.host.parentNode !== this.#root) {
        this.#root.append(surface.host);
        this.#invalidateSurface(surface);
      }
      if (
        surface.title.parentNode !== surface.host ||
        surface.text.parentNode !== surface.host ||
        surface.link.parentNode !== surface.host ||
        surface.custom.parentNode !== surface.host
      ) {
        surface.host.replaceChildren(
          surface.title,
          surface.text,
          surface.link,
          surface.custom,
        );
        this.#invalidateSurface(surface);
      }
      const mounted = surface.mounted;
      if (!mounted) continue;
      if (mounted.root.ownerDocument !== this.#document) {
        this.#failSurface(surface, "root-adopted");
        if (this.#destroyed) return;
        continue;
      }
      if (mounted.root.parentNode !== surface.custom) {
        surface.custom.replaceChildren(mounted.root);
        this.#invalidateSurface(surface);
      }
    }
  }
}

function snapshotMountResult(value: unknown): SafeMountResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return undefined;
  }
  const cleanup = descriptors.cleanup;
  const update = descriptors.update;
  if (!cleanup || !("value" in cleanup) || typeof cleanup.value !== "function")
    return undefined;
  if (update && (!("value" in update) || typeof update.value !== "function"))
    return undefined;
  return Object.freeze({
    cleanup: cleanup.value as SafeMountResult["cleanup"],
    ...(update
      ? { update: update.value as NonNullable<SafeMountResult["update"]> }
      : {}),
  });
}

function applyTheme(
  style: CSSStyleDeclaration,
  theme: SurfaceTheme | undefined,
): void {
  if (!theme) return;
  const values: Array<[string, string | number | undefined, string]> = [
    ["--peekling-surface-background", theme.background, ""],
    ["--peekling-surface-color", theme.color, ""],
    ["--peekling-surface-link", theme.linkColor, ""],
    ["--peekling-surface-border", theme.borderColor, ""],
    ["--peekling-surface-radius", theme.radius, "px"],
    ["--peekling-surface-width", theme.width, "px"],
    ["--peekling-surface-padding", theme.padding, "px"],
  ];
  for (const [name, value, unit] of values) {
    if (value !== undefined) style.setProperty(name, `${value}${unit}`);
  }
}
