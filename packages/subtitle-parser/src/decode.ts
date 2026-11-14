export interface DecodedSubtitle {
  text: string;
  /** Encoding that was actually used. */
  encoding: string;
}

/**
 * Decode subtitle bytes to text.
 *
 * Order: UTF-8 / UTF-16 byte-order mark, then strict UTF-8, then the legacy
 * single-byte fallback (subtitle files for Central/Eastern European languages
 * are still frequently Windows-1250/1251). The BOM is kept in the returned
 * text so `parseSrt` can record and restore it.
 */
export function decodeSubtitleBytes(
  bytes: Uint8Array,
  fallbackEncoding = 'windows-1252',
): DecodedSubtitle {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: decode(bytes, 'utf-8'), encoding: 'utf-8' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return { text: decode(bytes, 'utf-16le'), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return { text: decode(bytes, 'utf-16be'), encoding: 'utf-16be' };
  try {
    return { text: decode(bytes, 'utf-8', true), encoding: 'utf-8' };
  } catch {
    return { text: decode(bytes, fallbackEncoding), encoding: fallbackEncoding };
  }
}

function decode(bytes: Uint8Array, encoding: string, fatal = false): string {
  return new TextDecoder(encoding, { fatal, ignoreBOM: true }).decode(bytes);
}
