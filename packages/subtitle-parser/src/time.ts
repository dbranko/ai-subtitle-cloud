import { SrtParseError } from './types.js';

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** Format milliseconds as an SRT timestamp: `HH:MM:SS,mmm`. */
export function formatTimestamp(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0) {
    throw new RangeError(`Invalid subtitle time: ${ms}`);
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms % 1000, 3)}`;
}

const TIMESTAMP = String.raw`(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})`;
const TIMESTAMP_RE = new RegExp(`^${TIMESTAMP}$`);

/** `start --> end [settings]`. Tolerates `.` as the millisecond separator and a missing hour field. */
export const TIMING_LINE_RE = new RegExp(
  String.raw`^\s*(${TIMESTAMP})\s*-{1,2}>\s*(${TIMESTAMP})(?:[ \t]+(.*?))?\s*$`,
);

/** Parse `HH:MM:SS,mmm` (also `MM:SS,mmm` and `.` separator) to milliseconds. */
export function parseTimestamp(value: string): number {
  const match = TIMESTAMP_RE.exec(value.trim());
  if (!match) throw new SrtParseError(`Invalid timestamp: "${value}"`);
  const [, h = '0', m = '0', s = '0', frac = '0'] = match;
  const minutes = Number(m);
  const seconds = Number(s);
  if (minutes > 59 || seconds > 59) throw new SrtParseError(`Invalid timestamp: "${value}"`);
  // "1,5" means 500 ms: the fraction is right-padded, not left-padded.
  const millis = Number(frac.padEnd(3, '0'));
  return Number(h) * 3_600_000 + minutes * 60_000 + seconds * 1000 + millis;
}
