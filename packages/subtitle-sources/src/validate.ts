import {
  decodeSubtitleBytes,
  parseSrt,
  SrtParseError,
  validateSrt,
  type SubtitleEntry,
} from '@asc/subtitle-parser';

export class SourceValidationError extends Error {
  override name = 'SourceValidationError';
  constructor(
    readonly code: 'empty' | 'too_large' | 'not_srt' | 'broken' | 'too_short',
    message: string,
  ) {
    super(message);
  }
}

export interface ValidatedSource {
  /** The subtitle as text (decoded from whatever encoding the file used). */
  srt: string;
  entries: SubtitleEntry[];
  encoding: string;
  /** Tolerated irregularities, for information. */
  warnings: string[];
}

export interface SourceValidationOptions {
  maxBytes: number;
  /** Code page to assume when the bytes are not valid UTF-8. */
  legacyEncoding?: string | undefined;
  /** A real subtitle has at least this many cues. */
  minEntries?: number;
}

/**
 * Decide whether bytes from a subtitle source are a usable SRT subtitle.
 * Sources occasionally return HTML error pages, archives or other subtitle
 * formats; none of those may ever reach the translator.
 */
export function validateSourceBytes(
  bytes: Uint8Array,
  options: SourceValidationOptions,
): ValidatedSource {
  if (bytes.byteLength === 0)
    throw new SourceValidationError('empty', 'The subtitle file is empty.');
  if (bytes.byteLength > options.maxBytes) {
    throw new SourceValidationError(
      'too_large',
      'The subtitle file is larger than the allowed size.',
    );
  }
  // Archives and binary subtitle formats are not supported.
  if (
    (bytes[0] === 0x50 && bytes[1] === 0x4b) ||
    (bytes[0] === 0x1f && bytes[1] === 0x8b) ||
    bytes.includes(0)
  ) {
    const utf16 =
      (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
    if (!utf16)
      throw new SourceValidationError(
        'not_srt',
        'The file is an archive or binary file, not an SRT subtitle.',
      );
  }

  const decoded = decodeSubtitleBytes(bytes, options.legacyEncoding ?? 'windows-1252');
  const head = decoded.text.slice(0, 300).trimStart().toLowerCase();
  if (
    head.startsWith('<!doctype') ||
    head.startsWith('<html') ||
    head.startsWith('{') ||
    head.startsWith('webvtt')
  ) {
    throw new SourceValidationError('not_srt', 'The file is not an SRT subtitle.');
  }

  let parsed;
  try {
    parsed = parseSrt(decoded.text);
  } catch (err) {
    if (err instanceof SrtParseError) throw new SourceValidationError('not_srt', err.message);
    throw err;
  }
  const check = validateSrt(parsed.entries);
  if (!check.valid) {
    throw new SourceValidationError(
      'broken',
      check.errors[0]?.message ?? 'The subtitle is structurally invalid.',
    );
  }
  const minEntries = options.minEntries ?? 1;
  if (parsed.entries.filter((e) => e.text.trim() !== '').length < minEntries) {
    throw new SourceValidationError(
      'too_short',
      'The subtitle contains too few entries to be a real subtitle.',
    );
  }
  return {
    srt: decoded.text,
    entries: parsed.entries,
    encoding: decoded.encoding,
    warnings: [...parsed.warnings, ...check.warnings].map((w) => w.message),
  };
}
