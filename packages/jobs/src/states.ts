export const JOB_STATES = [
  'queued',
  'locating_source',
  'downloading_source',
  'parsing',
  'preparing_context',
  'translating',
  'validating',
  'saving',
  'completed',
  'failed',
  'cancelled',
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_STATES: readonly JobState[] = ['completed', 'failed', 'cancelled'];

/** States in which the job is owned by a worker and work is in progress. */
export const PROCESSING_STATES: readonly JobState[] = [
  'locating_source',
  'downloading_source',
  'parsing',
  'preparing_context',
  'translating',
  'validating',
  'saving',
];

/** Everything that is not terminal: queued or being processed. */
export const ACTIVE_STATES: readonly JobState[] = ['queued', ...PROCESSING_STATES];

/**
 * Legal transitions. Anything not listed is rejected.
 *  - Every processing state may move to `cancelled`, `failed`, or back to
 *    `queued` (recovery after a dead worker, or a graceful worker shutdown).
 *  - `validating → translating` allows re-translating segments found invalid.
 *  - `failed → queued` is the owner's explicit retry.
 *  - `completed` and `cancelled` are final.
 */
const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ['locating_source', 'cancelled', 'failed'],
  locating_source: ['downloading_source', 'queued', 'cancelled', 'failed'],
  downloading_source: ['parsing', 'queued', 'cancelled', 'failed'],
  parsing: ['preparing_context', 'queued', 'cancelled', 'failed'],
  preparing_context: ['translating', 'queued', 'cancelled', 'failed'],
  translating: ['validating', 'queued', 'cancelled', 'failed'],
  validating: ['saving', 'translating', 'queued', 'cancelled', 'failed'],
  saving: ['completed', 'queued', 'cancelled', 'failed'],
  completed: [],
  failed: ['queued'],
  cancelled: [],
};

export function isJobState(value: string): value is JobState {
  return (JOB_STATES as readonly string[]).includes(value);
}

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isActive(state: JobState): boolean {
  return !isTerminal(state);
}

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: JobState): readonly JobState[] {
  return TRANSITIONS[from];
}

export class InvalidTransitionError extends Error {
  override name = 'InvalidTransitionError';
  constructor(
    readonly from: JobState,
    readonly to: JobState,
  ) {
    super(`Illegal job state transition: ${from} → ${to}.`);
  }
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
