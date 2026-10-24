import { loadConfig } from './config.js';
import { createDb, migrate } from './db.js';
import { buildApp, bootstrapAdmin } from './app.js';

async function main() {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);
  const applied = await migrate(db);
  const app = await buildApp({ config, db });
  if (applied.length) app.fastify.log.info({ applied }, 'migrations applied');
  await bootstrapAdmin(config, app.repo, { info: (m) => app.fastify.log.info(m) });
  await app.fastify.listen({ port: config.PORT, host: config.HOST });

  const shutdown = async (sig: string) => {
    app.fastify.log.info(`${sig} received, shutting down`);
    await app.fastify.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
