import type { ApplicationState } from "./types";

export function canTransition(_from: ApplicationState, _to: ApplicationState): boolean {
  return true;
}

export function assertTransition(from: ApplicationState, to: ApplicationState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} -> ${to}`);
  }
}

