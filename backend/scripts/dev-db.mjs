import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.env.DEV_DB_PORT ?? 5432);
const dataDir = process.env.DEV_DB_DIR ?? '.pglite';
const db = await PGlite.create(dataDir);
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 1 });
await server.start();
console.log(
    `Local Postgres (PGlite) on 127.0.0.1:${port}, data in ${dataDir}. Run the API with DB_POOL_MAX=1.`
);

const stop = async () => {
    await server.stop();
    await db.close();
    process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
