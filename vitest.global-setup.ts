import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Tests import the generated Prisma client, so make sure it exists on a fresh checkout. */
export default function setup(): void {
  const generated = fileURLToPath(
    new URL('./packages/database/src/generated/prisma/client.ts', import.meta.url),
  );
  if (existsSync(generated)) return;
  execFileSync('pnpm', ['db:generate'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}
