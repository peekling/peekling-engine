const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function atLeastStableNode(actual, minimum) {
  const left = components(actual);
  const right = components(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

function components(value) {
  if (typeof value !== "string") return undefined;
  const match = STABLE_VERSION.exec(value);
  return match ? match.slice(1).map(Number) : undefined;
}
