'use strict';

const { getDb, closeDb, schemaText } = require('./index');

async function migrate({ quiet = false } = {}) {
  const db = getDb();
  await db.runScript(schemaText(db.dialect));
  if (!quiet) console.log(`[ebms] 数据模型已就绪 (driver=${db.dialect})`);
}

if (require.main === module) {
  migrate()
    .then(() => closeDb())
    .catch((err) => {
      console.error('[ebms] 迁移失败:', err.message);
      process.exitCode = 1;
    });
}

module.exports = { migrate };
