// Progress and pointer movement own different channels, so they compose.
const jobPlan = {
  baseline: {
    channels: ["state"],
    state: { state: "idle" },
  },
  rules: [
    {
      id: "follow-pointer",
      when: { source: "browser", event: "pointer.move" },
      effect: {
        channels: ["motion", "state"],
        motion: { type: "follow-pointer", speed: 180, arrivalRadius: 16 },
        state: { capability: "locomotion" },
      },
    },
    {
      id: "show-job-progress",
      when: { source: "application", event: "job.progress" },
      effect: {
        channels: ["surface:job-progress"],
        surfaces: [
          {
            id: "job-progress",
            contentId: "job-progress",
            data: "event-payload",
            disposition: "update",
            ordering: {
              sessionField: "sessionId",
              revisionField: "revision",
            },
          },
        ],
      },
    },
    {
      id: "finish-job",
      when: { source: "application", event: "job.finished" },
      effect: {
        channels: ["surface:job-progress"],
        surfaces: [
          {
            id: "job-progress",
            contentId: "job-finished",
            data: "event-payload",
            // The terminal Event replaces progress instead of resuming stale data.
            disposition: "replace",
            ordering: { sessionField: "sessionId", terminal: true },
          },
        ],
      },
    },
  ],
};

const status = document.querySelector("[data-example-status]");
const progressValue = document.querySelector("[data-progress-value]");
let sessionNumber = 0;
let sessionId = "job-0";
let revision = 0;
let completed = 0;

const companion = Peekling.hatch({
  packUrl: "/fixture/character.json",
  plan: jobPlan,
  position: "center",
  content: {
    "job-progress": { "top-center": { mountId: "job-status" } },
    "job-finished": { "top-center": { mountId: "job-status" } },
  },
  bindings: {
    mounts: {
      "job-status": ({ root, data }) => {
        const meter = document.createElement("progress");
        const label = document.createElement("span");
        meter.max = 4;
        root.append(meter, label);

        const render = (next) => {
          if (typeof next?.changedFiles === "number") {
            const message = `Finished: ${next.changedFiles} files changed`;
            meter.value = meter.max;
            label.textContent = message;
            progressValue.textContent = message;
            return;
          }
          const current = Number(next?.completed ?? 0);
          const total = Number(next?.total ?? 4);
          meter.max = total;
          meter.value = current;
          label.textContent = `${current} of ${total}`;
          progressValue.textContent = `${current} of ${total}`;
        };

        render(data);
        return {
          update: render,
          cleanup() {
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

document.querySelector("[data-start-job]").addEventListener("click", () => {
  sessionId = `job-${++sessionNumber}`;
  revision = 0;
  completed = 0;
  companion.emit("job.progress", { sessionId, revision, completed, total: 4 });
});

document.querySelector("[data-advance-job]").addEventListener("click", () => {
  completed = Math.min(3, completed + 1);
  companion.emit("job.progress", {
    sessionId,
    revision: ++revision,
    completed,
    total: 4,
  });
});

document.querySelector("[data-stale-job]").addEventListener("click", () => {
  companion.emit("job.progress", {
    sessionId,
    revision: 0,
    completed: 0,
    total: 4,
  });
});

document.querySelector("[data-finish-job]").addEventListener("click", () => {
  companion.emit("job.finished", { sessionId, changedFiles: 4 });
});

window.addEventListener("pagehide", () => companion.destroy(), { once: true });
