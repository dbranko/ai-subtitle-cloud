import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { defineConfig } from 'prisma/config';
// Imported by relative source path on purpose: the Prisma CLI must work before
// any workspace package has been built.
import { loadConfig } from '../config/src/index.ts';

const config = loadConfig();
if (config.paths.databaseFile !== ':memory:') {
  mkdirSync(dirname(config.paths.databaseFile), { recursive: true });
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: config.databaseUrl },
});
