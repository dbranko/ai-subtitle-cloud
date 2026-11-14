import type { SrtIssue, SubtitleEntry } from './types.js';

export interface SrtValidationResult {
  /** True when there are no errors (warnings do not make a file invalid). */
  valid: boolean;
  errors: SrtIssue[];
  warnings: SrtIssue[];
}

/**
 * Structural validation of a list of entries.
 *
 * Errors: things a player cannot use or that indicate a corrupted file.
 * Warnings: irregularities that are common in the wild and harmless to playback.
 */
export function validateSrt(entries: readonly SubtitleEntry[]): SrtValidationResult {
  const errors: SrtIssue[] = [];
  const warnings: SrtIssue[] = [];
  const add = (severity: 'error' | 'warning', code: string, message: string, position?: number) => {
    const issue: SrtIssue = { severity, code, message };
    if (position !== undefined) issue.position = position;
    (severity === 'error' ? errors : warnings).push(issue);
  };

  if (entries.length === 0) add('error', 'no_entries', 'The subtitle has no entries.');

  const seenIndexes = new Set<number>();
  let previous: SubtitleEntry | undefined;
  entries.forEach((e, i) => {
    const position = i + 1;
    const timesOk =
      Number.isInteger(e.startMs) && Number.isInteger(e.endMs) && e.startMs >= 0 && e.endMs >= 0;

    if (!Number.isInteger(e.index) || e.index < 0) {
      add('error', 'invalid_index', `Entry ${position} has an invalid index.`, position);
    } else if (seenIndexes.has(e.index)) {
      add('error', 'duplicate_index', `Index ${e.index} is used more than once.`, position);
    } else if (previous && e.index !== previous.index + 1) {
      add(
        'warning',
        'non_sequential_index',
        `Entry ${position} has index ${e.index}; expected ${previous.index + 1}.`,
        position,
      );
    }
    seenIndexes.add(e.index);

    if (!timesOk) {
      add('error', 'invalid_time', `Entry ${position} has an invalid timestamp.`, position);
    } else if (e.endMs < e.startMs) {
      add('error', 'negative_duration', `Entry ${position} ends before it starts.`, position);
    } else if (e.endMs === e.startMs) {
      add('warning', 'zero_duration', `Entry ${position} has zero duration.`, position);
    }

    if (previous && timesOk) {
      if (e.startMs < previous.startMs) {
        add(
          'warning',
          'out_of_order',
          `Entry ${position} starts before the previous entry.`,
          position,
        );
      } else if (e.startMs < previous.endMs) {
        add('warning', 'overlap', `Entry ${position} overlaps the previous entry.`, position);
      }
    }

    if (e.text.trim() === '') {
      add('warning', 'empty_text', `Entry ${position} has no text.`, position);
    }
    if (/\n\s*\n/.test(e.text)) {
      add('error', 'blank_line_in_text', `Entry ${position} contains a blank line.`, position);
    }
    previous = e;
  });

  return { valid: errors.length === 0, errors, warnings };
}
