import 'reflect-metadata';
import 'dotenv/config';
import { loadConfig } from './config.js';
import { createApp } from './create-app.js';
import { ConsoleMailer, ResendMailer, type Mailer } from './auth/mailer.js';
import { PgDb } from './db/pg.db.js';

async function main() {
  const config = loadConfig();
  const db = new PgDb(config.databaseUrl);
  const mailer: Mailer =
    config.mailDriver === 'resend'
      ? new ResendMailer(config.resendApiKey as string, config.mailFrom as string)
      : new ConsoleMailer();
  const app = await createApp({ config, db, mailer });
  await app.listen(config.port);
  console.log(`Florence API listening on ${config.port}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
