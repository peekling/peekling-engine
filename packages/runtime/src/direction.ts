import type { Direction, Point } from "./types.js";

const OCTANTS: Direction[] = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];

export function directionTo(from: Point, to: Point): Direction {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const octant = (Math.round(angle / (Math.PI / 4)) + 8) % 8;
  return OCTANTS[octant]!;
}
