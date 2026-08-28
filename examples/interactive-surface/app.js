const reviewPlan = {
  baseline: {
    channels: ["state"],
    state: { state: "idle" },
  },
  rules: [
    {
      id: "show-review-result",
      when: { source: "application", event: "review.completed" },
      effect: {
        channels: ["surface:review-result"],
        surfaces: [
          {
            id: "review-result",
            contentId: "review-result",
            data: "event-payload",
          },
        ],
      },
    },
  ],
};

const body = document.body;
const status = document.querySelector("[data-example-status]");
const resultOutput = document.querySelector("[data-review-result]");

const companion = Peekling.hatch({
  packUrl: "/fixture/character.json",
  plan: reviewPlan,
  position: "center",
  content: {
    "review-panel": { "top-center": { mountId: "review-control" } },
    "review-result": { "top-center": { mountId: "review-result" } },
  },
  bindings: {
    mounts: {
      "review-control": ({ root, data, signal, emit }) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = String(data?.label ?? "Save draft");
        root.append(button);
        body.dataset.reviewSurface = "mounted";

        button.addEventListener(
          "click",
          () => {
            button.disabled = true;
            // Host work stays outside the scheduler and returns later through emit.
            void saveDraft(String(data?.draftId ?? "draft"), signal).then(
              (saved) => {
                if (!signal.aborted) emit("review.completed", saved);
              },
              () => {
                if (!signal.aborted) status.textContent = "Host work failed";
              },
            );
          },
          { signal },
        );

        return {
          update(next) {
            button.textContent = String(next?.label ?? "Save draft");
          },
          cleanup() {
            countCleanup();
            root.replaceChildren();
            body.dataset.reviewSurface = "cleaned";
          },
        };
      },
      "review-result": ({ root, data }) => {
        const output = document.createElement("output");
        root.append(output);
        const render = (next) => {
          const message = `Saved ${String(next?.draftId ?? "draft")}`;
          output.textContent = message;
          resultOutput.textContent = message;
        };
        render(data);
        return {
          update: render,
          cleanup() {
            countCleanup();
            root.replaceChildren();
          },
        };
      },
    },
  },
  diagnostics: { console: false },
});

companion.ready.then(
  () => {
    status.textContent = "Ready";
  },
  (error) => {
    status.textContent = `Could not start: ${error.message}`;
  },
);

document.querySelector("[data-open-review]").addEventListener("click", () => {
  const handle = companion.override({
    effect: {
      channels: ["state", "surface:review-panel"],
      state: { state: "alert" },
      surfaces: [
        {
          id: "review-panel",
          contentId: "review-panel",
          data: { draftId: "draft-17", label: "Save draft" },
        },
      ],
    },
    until: { type: "event", name: "review.completed", timeout: 10_000 },
    mode: "replace",
  });
  void handle.finished.then((result) => {
    body.dataset.overrideReason = result.reason;
  });
});

document.querySelector("[data-destroy]").addEventListener("click", () => {
  companion.destroy();
  status.textContent = "Destroyed";
});

window.addEventListener("pagehide", () => companion.destroy(), { once: true });

function saveDraft(draftId, signal) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => resolve({ draftId }), 40);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Surface closed", "AbortError"));
      },
      { once: true },
    );
  });
}

function countCleanup() {
  body.dataset.reviewCleanups = String(
    Number(body.dataset.reviewCleanups ?? 0) + 1,
  );
}
