/** One subtitle cue. Times are integer milliseconds from the start of the video. */
export interface SubtitleEntry {
  /** Index number exactly as written in the file (assigned sequentially when missing). */
  index: number;
  startMs: number;
  endMs: number;
  /** Anything after the end timestamp on the timing line (e.g. `X1:40 X2:600 Y1:20 Y2:50`). */
  settings?: string;
  /** Cue text; lines separated by `\n`. Markup (`<i>`, `{\an8}`, …) is kept verbatim. */
  text: string;
}

/** File-level formatting that is restored when serializing. */
export interface SrtFormat {
  bom: boolean;
  newline: '\n' | '\r\n';
}

export const DEFAULT_SRT_FORMAT: SrtFormat = { bom: false, newline: '\n' };

export type SrtIssueSeverity = 'error' | 'warning';

export interface SrtIssue {
  severity: SrtIssueSeverity;
  code: string;
  message: string;
  /** 1-based position of the entry in the file, when the issue concerns one entry. */
  position?: number;
  /** 1-based line number in the source text, when known (parser only). */
  line?: number;
}

export interface ParsedSrt {
  entries: SubtitleEntry[];
  format: SrtFormat;
  /** Recoverable irregularities found while parsing (never errors: those throw). */
  warnings: SrtIssue[];
}

export class SrtParseError extends Error {
  override name = 'SrtParseError';
}
