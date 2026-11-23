import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOfficeApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { Settings } from './domain/settings.js';
import { buildHttp } from './http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(process.env.OFFICE_CONFIG ?? path.resolve(here, '../../../office.config.json'));
const cfg = loadConfig(configFile);
if (process.env.OFFICE_DB) cfg.server.dbPath = path.resolve(process.env.OFFICE_DB);
if (process.env.OFFICE_PORT) cfg.server.port = Number(process.env.OFFICE_PORT);
const db = openDb(cfg.server.dbPath);
const ctx = createOfficeApp(db, cfg);
const settings = new Settings(ctx.office, { retro: ctx.retro, configFile, setupScript: path.resolve(here, '../../../scripts/setup-team.mjs') });
const app = buildHttp(ctx, { logger: { level: 'warn' } as never, uiDir: path.resolve(here, '../../ui/dist'), settings });

await app.listen({ host: cfg.server.host, port: cfg.server.port });
ctx.usage.start();
ctx.retro.writeAgreementsFile();
console.log(`The OffAIce : http://${cfg.server.host}:${cfg.server.port}`);
console.log(`  base        ${cfg.server.dbPath}`);
console.log(`  équipe      ${cfg.team.repoPath}`);
console.log(`  transcripts ${cfg.usage.transcriptsDir}`);

const shutdown = async () => {
  ctx.usage.stop();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
