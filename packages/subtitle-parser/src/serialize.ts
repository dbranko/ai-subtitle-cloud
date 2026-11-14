import { formatTimestamp } from './time.js';
import { DEFAULT_SRT_FORMAT, type SrtFormat, type SubtitleEntry } from './types.js';

/**
 * Serialize entries to SRT text. Output is canonical: `index`, timing line,
 * text, one blank line between cues, and a single trailing newline.
 * Indexes and times are written exactly as stored — nothing is renumbered.
 */
export function serializeSrt(
  entries: readonly SubtitleEntry[],
  format: Partial<SrtFormat> = {},
): string {
  const { bom, newline } = { ...DEFAULT_SRT_FORMAT, ...format };
  const blocks = entries.map((e) => {
    const timing = `${formatTimestamp(e.startMs)} --> ${formatTimestamp(e.endMs)}`;
    const head = e.settings ? `${timing} ${e.settings}` : timing;
    // Blank lines inside text would split the cue; drop them defensively.
    const text = e.text
      .split(/\r\n|\r|\n/)
      .map((l) => l.replace(/\s+$/, ''))
      .filter((l) => l !== '');
    return [String(e.index), head, ...text].join(newline);
  });
  const body = blocks.length === 0 ? '' : blocks.join(newline + newline) + newline;
  return (bom ? '﻿' : '') + body;
}
