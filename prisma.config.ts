import { defineConfig } from 'prisma/config';

// Prisma 7 does not load .env on its own.
try {
  process.loadEnvFile();
} catch {
  // no .env file: variables come from the environment (CI, Render)
}

// The CLI talks to DIRECT_URL (no pgbouncer) when set, DATABASE_URL otherwise.
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

// Guard: commands that connect (migrate, db, studio…) refuse a non-local database
// unless explicitly allowed. Offline commands (generate, validate, format) always run.
const offline = ['generate', 'validate', 'format', 'version', '--version', '-v'];
const command = process.argv.slice(2).find((arg) => !arg.startsWith('--config'));
const connects = !offline.includes(command ?? '');
if (url && connects && process.env.PRISMA_ALLOW_REMOTE !== '1') {
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(
      `Refusing to run Prisma CLI against remote host "${host}". Set PRISMA_ALLOW_REMOTE=1 to allow it.`,
    );
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  ...(url ? { datasource: { url } } : {}),
});
