const mount = document.querySelector("[data-component-mount]");
const element = document.querySelector("#example-character");
const status = document.querySelector("[data-example-status]");

// The connected element owns one hatch-created instance and its teardown.
element.ready.then(
  () => {
    status.textContent = "Ready";
  },
  (error) => {
    status.textContent = `Could not start: ${error.message}`;
  },
);

document.querySelector("[data-disconnect]").addEventListener("click", () => {
  element.remove();
  status.textContent = "Disconnected";
});

document.querySelector("[data-reconnect]").addEventListener("click", () => {
  if (!element.isConnected) mount.append(element);
  element.ready.then(
    () => {
      status.textContent = "Ready again";
    },
    (error) => {
      status.textContent = `Could not reconnect: ${error.message}`;
    },
  );
});

window.addEventListener(
  "pagehide",
  () => {
    element.remove();
  },
  { once: true },
);
