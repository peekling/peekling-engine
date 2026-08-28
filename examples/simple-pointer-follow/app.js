// A small use case is still a Plan, not a separate behavior mode.
const pointerPlan = {
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
        motion: {
          type: "follow-pointer",
          speed: 180,
          arrivalRadius: 16,
        },
        state: { capability: "locomotion" },
      },
    },
  ],
};

const status = document.querySelector("[data-example-status]");
const companion = Peekling.hatch({
  packUrl: "/fixture/character.json",
  plan: pointerPlan,
  position: "center",
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

window.addEventListener("pagehide", () => companion.destroy(), { once: true });
