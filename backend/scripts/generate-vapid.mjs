import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import * as webpush from 'web-push';

const file = process.argv[2] ?? '.env';
const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
if (/^VAPID_PUBLIC_KEY=.+$/m.test(current) && /^VAPID_PRIVATE_KEY=.+$/m.test(current)) {
    console.log(`VAPID keys already set in ${file}. Nothing changed.`);
    process.exit(0);
}
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
appendFileSync(
    file,
    `${current.endsWith('\n') || current === '' ? '' : '\n'}VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\n`
);
console.log(`Wrote a new VAPID key pair to ${file}. Public key: ${publicKey}`);
