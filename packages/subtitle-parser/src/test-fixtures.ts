import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = new URL('../../../fixtures/subtitles/', import.meta.url);

/** Raw bytes of a fixture from `fixtures/subtitles/` (test helper). */
export function fixtureBytes(name: string): Uint8Array {
  return readFileSync(fileURLToPath(new URL(name, DIR)));
}

/** Fixture decoded as UTF-8 text, BOM preserved (test helper). */
export function fixtureText(name: string): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(fixtureBytes(name));
}
