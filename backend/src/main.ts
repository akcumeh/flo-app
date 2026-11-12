import 'reflect-metadata';
import 'dotenv/config';
import { loadConfig } from './config.js';
import { createApp } from './create-app.js';
import { ConsoleMailer, DisabledMailer, ResendMailer, type Mailer } from './auth/mailer.js';
import { PgDb } from './db/pg.db.js';
import { JobsService } from './jobs/jobs.service.js';
import { SchedulerService } from './jobs/scheduler.service.js';

async function main() {
    const config = loadConfig();
    const db = new PgDb(config.databaseUrl, { max: config.dbPoolMax });
    const mailer: Mailer =
        config.mailDriver === 'resend'
            ? new ResendMailer(config.resendApiKey as string, config.mailFrom as string)
            : config.mailDriver === 'disabled'
              ? new DisabledMailer()
              : new ConsoleMailer();
    const app = await createApp({ config, db, mailer });
    await app.listen(config.port);
    app.get(JobsService).start();
    app.get(SchedulerService).start();
    process.stdout
        .write(`${JSON.stringify({ time: new Date().toISOString(), level: 'info', msg: `Florence API listening on ${config.port}` })}
`);
    const shutdown = async () => {
        await app.close();
        await db.close();
        process.exit(0);
    };
    process.once('SIGTERM', () => void shutdown());
    process.once('SIGINT', () => void shutdown());
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
