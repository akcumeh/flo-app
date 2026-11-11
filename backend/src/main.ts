import 'reflect-metadata';
import 'dotenv/config';
import { loadConfig } from './config.js';
import { createApp } from './create-app.js';
import { ConsoleMailer } from './auth/mailer.js';
import { PgDb } from './db/pg.db.js';

async function main() {
  const config = loadConfig();
  const db = new PgDb(config.databaseUrl);
  const app = await createApp({ config, db, mailer: new ConsoleMailer() });
  await app.listen(config.port);
  console.log(`Florence API listening on ${config.port}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
