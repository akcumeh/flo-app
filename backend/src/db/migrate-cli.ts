import 'dotenv/config';
import { loadConfig } from '../config.js';
import { migrate, seed } from './migrate.js';
import { PgDb } from './pg.db.js';

async function main() {
    const db = new PgDb(loadConfig().databaseUrl, { max: loadConfig().dbPoolMax });
    try {
        const ran = await migrate(db);
        console.log(ran.length === 0 ? 'Nothing to apply.' : `Applied: ${ran.join(', ')}`);
        console.log(`Seeded: ${(await seed(db)).join(', ')}`);
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
