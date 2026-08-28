import assert from "node:assert/strict";
import test from "node:test";
import { SectionTracker } from "../dist/sections.js";

function controlledTimers() {
  let nextId = 1;
  const pending = new Map<
    number,
    { callback: () => void; delay: number | undefined }
  >();
  return {
    setTimeout(callback: TimerHandler, delay?: number): number {
      const id = nextId++;
      pending.set(id, { callback: callback as () => void, delay });
      return id;
    },
    clearTimeout(id: number): void {
      pending.delete(id);
    },
    flushNext(): number | undefined {
      const entry = pending.entries().next().value;
      assert.ok(entry, "a trailing refresh timer is pending");
      const [id, timer] = entry;
      pending.delete(id);
      timer.callback();
      return timer.delay;
    },
    get size(): number {
      return pending.size;
    },
  };
}

test("invalid selectors fail before any document observer is started", () => {
  let intersectionConstructed = 0;
  let mutationConstructed = 0;
  let mutationObserved = 0;
  class IntersectionFixture {
    constructor() {
      intersectionConstructed++;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class MutationFixture {
    constructor() {
      mutationConstructed++;
    }
    observe() {
      mutationObserved++;
    }
    disconnect() {}
  }
  const document = {
    documentElement: {},
    querySelector: () => {
      throw new DOMException("invalid selector", "SyntaxError");
    },
  } as unknown as Document;
  const window = {
    IntersectionObserver: IntersectionFixture,
    MutationObserver: MutationFixture,
  } as unknown as Window;

  assert.throws(
    () => new SectionTracker(document, window, ["#bad["], [0, 1], () => {}),
    /Invalid section selector/,
  );
  assert.equal(intersectionConstructed, 0);
  assert.equal(mutationConstructed, 0);
  assert.equal(mutationObserved, 0);
});

test("section snapshots do not rescan or measure the host document on every frame", () => {
  let mutationCallback!: MutationCallback;
  let queries = 0;
  let measurements = 0;
  class IntersectionFixture {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class MutationFixture {
    constructor(callback: MutationCallback) {
      mutationCallback = callback;
    }
    observe() {}
    disconnect() {}
  }
  const element = {
    isConnected: true,
    getBoundingClientRect: () => {
      measurements += 1;
      return { left: 0, top: 0, right: 10, bottom: 10 };
    },
  } as unknown as Element;
  const document = {
    documentElement: {},
    querySelector: () => {
      queries++;
      return element;
    },
  } as unknown as Document;
  const window = {
    IntersectionObserver: IntersectionFixture,
    MutationObserver: MutationFixture,
  } as unknown as Window;
  let wakes = 0;
  const tracker = new SectionTracker(
    document,
    window,
    ["#tracked"],
    [0, 1],
    () => wakes++,
  );

  tracker.snapshot();
  tracker.snapshot();
  assert.equal(queries, 1);
  assert.equal(measurements, 0, "intersection ratios need no layout read");

  mutationCallback([], {} as never);
  mutationCallback([], {} as never);
  assert.equal(queries, 1);
  tracker.snapshot();
  assert.equal(queries, 1, "connected selectors are not requeried");
  assert.equal(wakes, 0, "unrelated mutations need no runtime wake");
  tracker.destroy();
});

test("mutations wholly inside runtime-owned roots do not refresh missing selectors", () => {
  let mutationCallback!: MutationCallback;
  let queries = 0;
  let wakes = 0;
  const timers = controlledTimers();
  class IntersectionFixture {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class MutationFixture {
    constructor(callback: MutationCallback) {
      mutationCallback = callback;
    }
    observe() {}
    disconnect() {}
  }
  const document = {
    documentElement: {},
    querySelector: () => {
      queries += 1;
      return null;
    },
  } as unknown as Document;
  const tracker = new SectionTracker(
    document,
    {
      IntersectionObserver: IntersectionFixture,
      MutationObserver: MutationFixture,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    } as unknown as Window,
    ["#missing"],
    [0, 1],
    () => wakes++,
  );
  const runtimeTarget = {
    closest: (selector: string) =>
      selector.includes("data-peekling-host") ? {} : null,
  } as unknown as Node;
  const hostTarget = { closest: () => null } as unknown as Node;

  mutationCallback(
    [{ target: runtimeTarget }] as MutationRecord[],
    {} as never,
  );
  tracker.snapshot();
  assert.equal(queries, 1);
  assert.equal(wakes, 0);

  mutationCallback([{ target: hostTarget }] as MutationRecord[], {} as never);
  assert.equal(timers.size, 1);
  assert.equal(queries, 1);
  assert.equal(wakes, 0);
  assert.equal(timers.flushNext(), 250);
  tracker.snapshot();
  assert.equal(queries, 2);
  assert.equal(wakes, 1);
  tracker.destroy();
});

test("missing section refresh wakes follow a 250 ms trailing cadence", () => {
  let mutationCallback!: MutationCallback;
  let queries = 0;
  let wakes = 0;
  const timers = controlledTimers();
  class IntersectionFixture {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class MutationFixture {
    constructor(callback: MutationCallback) {
      mutationCallback = callback;
    }
    observe() {}
    disconnect() {}
  }
  const document = {
    documentElement: {},
    querySelector: () => {
      queries += 1;
      return null;
    },
  } as unknown as Document;
  const tracker = new SectionTracker(
    document,
    {
      IntersectionObserver: IntersectionFixture,
      MutationObserver: MutationFixture,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    } as unknown as Window,
    ["#missing"],
    [0, 1],
    () => wakes++,
  );
  const hostTarget = { closest: () => null } as unknown as Node;
  const records = [{ target: hostTarget }] as MutationRecord[];

  for (let index = 0; index < 10; index++) {
    mutationCallback(records, {} as never);
  }
  assert.equal(wakes, 0, "the first mutation burst does not wake immediately");
  assert.equal(timers.size, 1, "one trailing refresh is scheduled");
  assert.equal(timers.flushNext(), 250);
  assert.equal(wakes, 1);
  assert.equal(queries, 1, "the timer wakes but does not query the document");
  tracker.snapshot();
  assert.equal(queries, 2);

  for (let index = 0; index < 10; index++) {
    mutationCallback(records, {} as never);
  }
  assert.equal(timers.size, 1, "sustained mutations keep one timer");
  assert.equal(timers.flushNext(), 250);
  assert.equal(wakes, 2, "sustained mutations wake once per cadence");
  tracker.destroy();
});

test("parked section tracking keeps zero refresh timers", () => {
  let mutationCallback!: MutationCallback;
  let queries = 0;
  let wakes = 0;
  const timers = controlledTimers();
  class IntersectionFixture {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class MutationFixture {
    constructor(callback: MutationCallback) {
      mutationCallback = callback;
    }
    observe() {}
    disconnect() {}
  }
  const document = {
    documentElement: {},
    querySelector: () => {
      queries += 1;
      return null;
    },
  } as unknown as Document;
  const tracker = new SectionTracker(
    document,
    {
      IntersectionObserver: IntersectionFixture,
      MutationObserver: MutationFixture,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    } as unknown as Window,
    ["#missing"],
    [0, 1],
    () => wakes++,
  );
  const records = [
    { target: { closest: () => null } as unknown as Node },
  ] as MutationRecord[];

  mutationCallback(records, {} as never);
  assert.equal(timers.size, 1);
  tracker.setSuspended(true);
  assert.equal(timers.size, 0, "parking cancels the trailing refresh");

  mutationCallback(records, {} as never);
  assert.equal(timers.size, 0, "parked mutation deliveries schedule no work");
  assert.equal(wakes, 0);

  tracker.setSuspended(false);
  assert.equal(queries, 2, "resuming performs one guarded refresh");
  mutationCallback(records, {} as never);
  assert.equal(timers.size, 1, "active tracking schedules refreshes again");
  tracker.destroy();
  assert.equal(timers.size, 0, "destroy clears the active refresh timer");
});

test("section visibility deliveries stay ordered when both edges arrive before a snapshot", () => {
  let intersectionCallback!: IntersectionObserverCallback;
  class IntersectionFixture {
    constructor(callback: IntersectionObserverCallback) {
      intersectionCallback = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const element = { isConnected: true } as Element;
  const document = {
    documentElement: {},
    querySelector: () => element,
  } as unknown as Document;
  const facts: unknown[] = [];
  let wakes = 0;
  const tracker = new SectionTracker(
    document,
    { IntersectionObserver: IntersectionFixture } as unknown as Window,
    ["#tracked"],
    [0, 0.25, 1],
    () => wakes++,
    (fact: unknown) => facts.push(fact),
  );

  intersectionCallback(
    [
      {
        target: element,
        isIntersecting: true,
        intersectionRatio: 0.5,
      },
    ] as never,
    {} as never,
  );
  intersectionCallback(
    [
      {
        target: element,
        isIntersecting: false,
        intersectionRatio: 0,
      },
    ] as never,
    {} as never,
  );

  assert.deepEqual(facts, [
    { selector: "#tracked", previousRatio: 0, ratio: 0.5 },
    { selector: "#tracked", previousRatio: 0.5, ratio: 0 },
  ]);
  assert.deepEqual(tracker.snapshot()["#tracked"], {
    ratio: 0,
    previousRatio: 0.5,
  });
  assert.equal(wakes, 2);
  intersectionCallback(
    [
      {
        target: element,
        isIntersecting: false,
        intersectionRatio: 0,
      },
    ] as never,
    {} as never,
  );
  assert.equal(facts.length, 2, "a no-op delivery emits no fact");
  assert.equal(wakes, 2, "a no-op delivery schedules no wake");
  tracker.destroy();
});

test("mutation refresh coalesces work and preserves ratio across replacement", () => {
  let intersectionCallback!: IntersectionObserverCallback;
  let mutationCallback!: MutationCallback;
  let queries = 0;
  let wakes = 0;
  const timers = controlledTimers();
  class IntersectionFixture {
    constructor(callback: IntersectionObserverCallback) {
      intersectionCallback = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class MutationFixture {
    constructor(callback: MutationCallback) {
      mutationCallback = callback;
    }
    observe() {}
    disconnect() {}
  }
  const first = { isConnected: true } as Element;
  const second = { isConnected: true } as Element;
  let match = first;
  const document = {
    documentElement: {},
    querySelector: () => {
      queries += 1;
      return match;
    },
  } as unknown as Document;
  const facts: unknown[] = [];
  const tracker = new SectionTracker(
    document,
    {
      IntersectionObserver: IntersectionFixture,
      MutationObserver: MutationFixture,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    } as unknown as Window,
    ["#tracked"],
    [0, 0.5, 1],
    () => wakes++,
    (fact: unknown) => facts.push(fact),
  );
  intersectionCallback(
    [
      {
        target: first,
        isIntersecting: true,
        intersectionRatio: 0.75,
      },
    ] as never,
    {} as never,
  );
  facts.length = 0;
  wakes = 0;
  Object.assign(first, { isConnected: false });
  match = second;

  mutationCallback([], {} as never);
  mutationCallback([], {} as never);
  assert.equal(wakes, 0, "the pending refresh waits for its cadence");
  assert.equal(timers.size, 1, "one pending refresh uses one timer");
  assert.equal(queries, 1, "mutation delivery does not query immediately");
  assert.equal(timers.flushNext(), 250);
  assert.equal(wakes, 1, "the trailing refresh schedules one runtime wake");
  assert.deepEqual(tracker.snapshot()["#tracked"], {
    ratio: 0.75,
    previousRatio: 0,
  });
  assert.equal(queries, 2, "one pending selector is queried once");

  intersectionCallback(
    [
      {
        target: second,
        isIntersecting: true,
        intersectionRatio: 0.75,
      },
    ] as never,
    {} as never,
  );
  assert.deepEqual(facts, [], "replacement does not synthesize an edge");
  intersectionCallback(
    [
      {
        target: second,
        isIntersecting: false,
        intersectionRatio: 0,
      },
    ] as never,
    {} as never,
  );
  assert.deepEqual(facts, [
    { selector: "#tracked", previousRatio: 0.75, ratio: 0 },
  ]);
  tracker.destroy();
});

test("host selector failures are handed to the next guarded frame", () => {
  let mutationCallback!: MutationCallback;
  let failQueries = false;
  let mutationDisconnected = false;
  const timers = controlledTimers();
  class IntersectionFixture {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class MutationFixture {
    constructor(callback: MutationCallback) {
      mutationCallback = callback;
    }
    observe() {}
    disconnect() {
      mutationDisconnected = true;
    }
  }
  const element = {
    isConnected: true,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1, bottom: 1 }),
  } as unknown as Element;
  const document = {
    documentElement: {},
    querySelector: () => {
      if (failQueries) throw new DOMException("host failure", "SyntaxError");
      return element;
    },
  } as unknown as Document;
  const window = {
    IntersectionObserver: IntersectionFixture,
    MutationObserver: MutationFixture,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  } as unknown as Window;
  const tracker = new SectionTracker(
    document,
    window,
    ["#tracked"],
    [0, 1],
    () => {},
  );

  failQueries = true;
  Object.assign(element, { isConnected: false });
  assert.doesNotThrow(() => mutationCallback([], {} as never));
  assert.equal(timers.flushNext(), 250);
  assert.throws(() => tracker.snapshot(), /Invalid section selector/);
  assert.equal(mutationDisconnected, true);
  tracker.destroy();
});

test("section tracking shares elements, refreshes dynamic nodes, and clears stale state", () => {
  let intersectionCallback!: IntersectionObserverCallback;
  let mutationCallback!: MutationCallback;
  let observerDisconnected = false;
  let mutationDisconnected = false;
  const timers = controlledTimers();
  const observed = new Set<Element>();
  class IntersectionFixture {
    constructor(callback: IntersectionObserverCallback) {
      intersectionCallback = callback;
    }
    observe(element: Element) {
      observed.add(element);
    }
    unobserve(element: Element) {
      observed.delete(element);
    }
    disconnect() {
      observerDisconnected = true;
      observed.clear();
    }
  }
  class MutationFixture {
    constructor(callback: MutationCallback) {
      mutationCallback = callback;
    }
    observe() {}
    disconnect() {
      mutationDisconnected = true;
    }
  }
  const first = {
    isConnected: true,
    getBoundingClientRect: () => ({ left: 1, top: 2, right: 31, bottom: 42 }),
  } as unknown as Element;
  const second = {
    isConnected: true,
    getBoundingClientRect: () => ({ left: 5, top: 6, right: 35, bottom: 46 }),
  } as unknown as Element;
  const matches = new Map<string, Element>([
    [".shared", first],
    ["#same", first],
  ]);
  const document = {
    documentElement: {},
    querySelector: (selector: string) => matches.get(selector) ?? null,
  } as unknown as Document;
  const window = {
    IntersectionObserver: IntersectionFixture,
    MutationObserver: MutationFixture,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  } as unknown as Window;
  let wakes = 0;
  const tracker = new SectionTracker(
    document,
    window,
    [".shared", "#same"],
    [0, 0.5, 1],
    () => wakes++,
  );
  assert.equal(observed.size, 1);
  intersectionCallback(
    [{ target: first, isIntersecting: true, intersectionRatio: 0.5 }] as never,
    {} as never,
  );
  assert.equal(tracker.snapshot()[".shared"]?.ratio, 0.5);
  assert.equal(tracker.snapshot()["#same"]?.ratio, 0.5);

  Object.assign(first, { isConnected: false });
  matches.clear();
  mutationCallback([], {} as never);
  assert.equal(timers.flushNext(), 250);
  const removed = tracker.snapshot();
  assert.equal(removed[".shared"]?.ratio, 0);

  matches.set(".shared", second);
  matches.set("#same", second);
  mutationCallback([], {} as never);
  assert.equal(timers.flushNext(), 250);
  tracker.snapshot();
  assert.equal(observed.has(second), true);
  intersectionCallback(
    [
      { target: second, isIntersecting: true, intersectionRatio: 0.75 },
    ] as never,
    {} as never,
  );
  assert.equal(tracker.snapshot()["#same"]?.ratio, 0.75);
  assert.ok(wakes >= 3);
  tracker.destroy();
  assert.equal(observerDisconnected, true);
  assert.equal(mutationDisconnected, true);
});

test("section snapshots preserve own prototype-named selector keys", () => {
  class IntersectionFixture {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const element = {
    isConnected: true,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1, bottom: 1 }),
  } as unknown as Element;
  const document = {
    documentElement: {},
    querySelector: () => element,
  } as unknown as Document;
  const tracker = new SectionTracker(
    document,
    { IntersectionObserver: IntersectionFixture } as unknown as Window,
    ["__proto__"],
    [0, 1],
    () => {},
  );

  const snapshot = tracker.snapshot();
  assert.equal(Object.hasOwn(snapshot, "__proto__"), true);
  assert.equal(snapshot["__proto__"]?.ratio, 0);
  tracker.destroy();
});
