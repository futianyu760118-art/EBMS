'use strict';

// 数据库驱动按架构方案选型为 PostgreSQL；DB_DRIVER=sqlite 时退到本地嵌入式库，
// 仅供无 PG 实例的本地运行与自检使用（repository 层保证可迁移）。
const DB_DRIVER = process.env.DB_DRIVER || 'pg';

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4600),
  db: {
    driver: DB_DRIVER,
    sqliteFile: process.env.SQLITE_FILE || './data/ebms.sqlite',
    pg: {
      host: process.env.PGHOST || '127.0.0.1',
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER || 'ebms',
      password: process.env.PGPASSWORD || '',
      database: process.env.PGDATABASE || 'ebms',
    },
  },
  auth: {
    jwtSecret: process.env.EBMS_JWT_SECRET || 'dev-only-secret-do-not-use-in-production',
    tokenTtlSeconds: Number(process.env.EBMS_TOKEN_TTL || 8 * 3600),
  },
  // 视图工作域分页默认值（F10 口径：默认 20 条可配置）
  pagination: {
    defaultLimit: Number(process.env.EBMS_DEFAULT_LIMIT || 20),
    maxLimit: Number(process.env.EBMS_MAX_LIMIT || 100),
  },
  // 逾期判定基准可注入（测试用固定时钟）；默认取系统当前时间
  clock: () => new Date(),
};
