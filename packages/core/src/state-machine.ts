import type { ApplicationState } from "./types";

const allowedTransitions: Record<ApplicationState, ApplicationState[]> = {
  discovered: ["normalized", "rejected", "shortlisted", "error"],
  normalized: ["evaluated", "rejected", "shortlisted", "error"],
  evaluated: ["rejected", "shortlisted", "resume_ready", "error"],
  rejected: ["evaluated", "shortlisted", "error"],
  shortlisted: ["rejected", "resume_ready", "blocked", "error"],
  resume_ready: ["rejected", "shortlisted", "ready_to_apply", "blocked", "error"],
  ready_to_apply: ["rejected", "shortlisted", "in_review", "blocked", "error"],
  in_review: ["rejected", "shortlisted", "submitted", "blocked", "error"],
  submitted: ["blocked", "error"],
  blocked: ["rejected", "shortlisted", "ready_to_apply", "error"],
  error: ["discovered", "normalized", "evaluated", "rejected", "shortlisted", "blocked"]
};

export function canTransition(from: ApplicationState, to: ApplicationState): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertTransition(from: ApplicationState, to: ApplicationState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} -> ${to}`);
  }
}

