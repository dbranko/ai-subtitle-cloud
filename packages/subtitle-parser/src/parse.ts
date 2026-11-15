import { parseTimestamp, TIMING_LINE_RE } from './time.js';
import {
  SrtParseError,
  type ParsedSrt,
  type SrtFormat,
  type SrtIssue,
  type SubtitleEntry,
} from './types.js';

// At most 9 digits: a longer number is not an index (it would not survive as an integer).
const INDEX_LINE_RE = /^\s*\d{1,9}\s*$/;

/**
 * Parse SRT text.
 *
 * Strict about what matters (timestamps must be valid) and tolerant of the
 * irregularities real-world files contain: BOM, CRLF or CR line endings,
 * missing blank lines between cues, missing index numbers, extra blank lines,
 * `.` instead of `,` in timestamps. Every tolerated irregularity is reported
 * as a warning; text content and markup are never altered.
 *
 * @throws SrtParseError when the input contains no cue at all or a cue has an unusable timing line.
 */
export function parseSrt(input: string): ParsedSrt {
  const bom = input.charCodeAt(0) === 0xfeff;
  const body = bom ? input.slice(1) : input;
  const format: SrtFormat = { bom, newline: /\r\n/.test(body) ? '\r\n' : '\n' };
  const lines = body.split(/\r\n|\r|\n/);
  const warnings: SrtIssue[] = [];

  const timingLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (TIMING_LINE_RE.test(lines[i] ?? '')) timingLines.push(i);
  }
  if (timingLines.length === 0) {
    throw new SrtParseError('No subtitle entries found: the input is not a valid SRT file.');
  }

  // A numeric line directly above a timing line is that cue's index.
  const hasIndexLine = timingLines.map((t) => t > 0 && INDEX_LINE_RE.test(lines[t - 1] ?? ''));

  const firstCueStart = (timingLines[0] ?? 0) - (hasIndexLine[0] ? 1 : 0);
  if (lines.slice(0, firstCueStart).some((l) => l.trim() !== '')) {
    warnings.push({
      severity: 'warning',
      code: 'leading_content',
      message: 'Ignored unexpected content before the first subtitle entry.',
      line: 1,
    });
  }

  const entries: SubtitleEntry[] = [];
  for (let n = 0; n < timingLines.length; n++) {
    const t = timingLines[n] ?? 0;
    const position = n + 1;
    const match = TIMING_LINE_RE.exec(lines[t] ?? '');
    if (!match) continue; // unreachable: the line was matched above

    // Groups: 1 = start, 6 = end, 11 = settings (each timestamp has 4 inner groups).
    const startMs = parseTimestamp(match[1] ?? '');
    const endMs = parseTimestamp(match[6] ?? '');
    const settings = match[11]?.trim();

    let index: number;
    if (hasIndexLine[n]) {
      index = Number((lines[t - 1] ?? '').trim());
    } else {
      index = (entries[entries.length - 1]?.index ?? 0) + 1;
      warnings.push({
        severity: 'warning',
        code: 'missing_index',
        message: `Entry ${position} has no index number; assigned ${index}.`,
        position,
        line: t + 1,
      });
    }

    const nextTiming = timingLines[n + 1];
    const textEnd =
      nextTiming === undefined ? lines.length : nextTiming - (hasIndexLine[n + 1] ? 1 : 0);
    const rawText = lines.slice(t + 1, textEnd);

    // Trailing whitespace is never meaningful in SRT; leading whitespace may be (indentation).
    const trimmed = rawText.map((l) => l.replace(/\s+$/, ''));
    while (trimmed.length > 0 && trimmed[0] === '') trimmed.shift();
    while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();

    if (
      nextTiming !== undefined &&
      rawText.length > 0 &&
      rawText[rawText.length - 1]?.trim() !== ''
    ) {
      warnings.push({
        severity: 'warning',
        code: 'missing_blank_line',
        message: `No blank line between entry ${position} and the next entry.`,
        position,
        line: textEnd,
      });
    }
    if (trimmed.includes('')) {
      // A blank line inside a cue cannot be represented in SRT (it would end the cue).
      warnings.push({
        severity: 'warning',
        code: 'blank_line_in_text',
        message: `Removed blank line(s) inside the text of entry ${position}.`,
        position,
        line: t + 2,
      });
    }

    const entry: SubtitleEntry = {
      index,
      startMs,
      endMs,
      text: trimmed.filter((l) => l !== '').join('\n'),
    };
    if (settings) entry.settings = settings;
    entries.push(entry);
  }

  return { entries, format, warnings };
}
