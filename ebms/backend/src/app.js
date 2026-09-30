/**
 * Express 应用装配（接入层）。
 *
 * 分层：routes（接入）→ services（应用）→ repositories（数据）→ domain（领域）。
 */

import express from 'express';
import cors from 'cors';

import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { createChainRepository } from './repositories/chainRepository.js';
import { createAuditRepository } from './repositories/auditRepository.js';
import { createAttributionRepository } from './repositories/attributionRepository.js';
import { createTraceService } from './services/traceService.js';
import { createAttributionService } from './services/attributionService.js';
import { createTraceRouter } from './routes/trace.js';
import { createReasonRouter } from './routes/reasons.js';
import { createActorMiddleware } from './middleware/actor.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export function createApp({ db: providedDb, config: providedConfig } = {}) {
  const config = providedConfig ?? loadConfig();
  const db = providedDb ?? openDatabase({ file: config.dbFile });

  const chainRepository = createChainRepository(db);
  const auditRepository = createAuditRepository(db);
  const attributionRepository = createAttributionRepository(db);
  const traceService = createTraceService({ chainRepository, auditRepository });
  const attributionService = createAttributionService({ chainRepository, attributionRepository });
  const actor = createActorMiddleware();

  const app = express();
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/v1/trace/health', (req, res) => {
    res.json({ status: 'ok', module: 'M03-EBMS', feature: 'PAND-84-reverse-trace' });
  });

  app.get('/api/v1/attribution/health', (req, res) => {
    res.json({ status: 'ok', module: 'M03-EBMS', feature: 'PAND-80-reason-attribution' });
  });

  app.use('/api/v1', createTraceRouter({ traceService, actor }));
  app.use('/api/v1', createReasonRouter({ attributionService, actor }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  app.locals.db = db;
  app.locals.traceService = traceService;
  app.locals.attributionService = attributionService;
  app.locals.config = config;
  return app;
}

export function createServer(options = {}) {
  const app = createApp(options);
  return { app, db: app.locals.db, config: app.locals.config };
}
