import cluster from "node:cluster";
import { buildApp, makeDeps } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, migrate } from "./db.js";

const cfg = loadConfig();

async function startWorker() {
  const db = createDb(cfg.DATABASE_URL, cfg.DB_POOL_MAX);
  const deps = makeDeps(cfg, db);
  const app = await buildApp(deps);
  await app.listen({ port: cfg.PORT, host: cfg.HOST });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    app.log.info("shutting down");
    await app.close(); // stops accepting, lets in-flight requests finish
    await Promise.allSettled([db.end(), deps.redis.quit()]);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (cluster.isPrimary && cfg.WEB_CONCURRENCY > 1) {
  const db = createDb(cfg.DATABASE_URL, 2);
  await migrate(db);
  await db.end();
  for (let i = 0; i < cfg.WEB_CONCURRENCY; i++) cluster.fork();
  cluster.on("exit", (w, code) => {
    if (code !== 0) cluster.fork(); // replace crashed workers
  });
} else {
  if (cfg.WEB_CONCURRENCY <= 1) {
    const db = createDb(cfg.DATABASE_URL, 2);
    await migrate(db);
    await db.end();
  }
  await startWorker();
}
