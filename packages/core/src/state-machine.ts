import type { ApplicationState } from "./types";

const allowedTransitions: Record<ApplicationState, ApplicationState[]> = {
  discovered: ["normalized", "error"],
  normalized: ["evaluated", "error"],
  evaluated: ["rejected", "shortlisted", "error"],
  rejected: ["error"],
  shortlisted: ["resume_ready", "blocked", "error"],
  resume_ready: ["ready_to_apply", "blocked", "error"],
  ready_to_apply: ["in_review", "blocked", "error"],
  in_review: ["submitted", "blocked", "error"],
  submitted: ["error"],
  blocked: ["ready_to_apply", "error"],
  error: ["discovered", "normalized", "evaluated", "blocked"]
};

export function canTransition(from: ApplicationState, to: ApplicationState): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertTransition(from: ApplicationState, to: ApplicationState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} -> ${to}`);
  }
}
