'use strict';

const config = require('./config');
const { createApp } = require('./app');
const { getDb, closeDb } = require('./db');
const { migrate } = require('./db/migrate');

async function main() {
  await migrate({ quiet: true });
  const app = createApp();
  const server = app.listen(config.port, () => {
    const db = getDb();
    console.log(`[ebms] 后端已启动 http://127.0.0.1:${config.port}  (db=${db.dialect})`);
  });

  const shutdown = async () => {
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[ebms] 启动失败:', err);
  process.exit(1);
});
