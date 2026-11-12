export interface QueuedAnswer {
  key: string;
  sessionId: string;
  itemId: number;
  answer?: string;
  outcome?: 'knew' | 'unsure' | 'didnt_know';
  dontKnow?: boolean;
  answeredAt: string;
}

export type SendAnswer = (a: QueuedAnswer) => Promise<'sent' | 'drop' | 'retry'>;

const DB_NAME = 'florence';
const STORE = 'answers';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('answeredAt', 'answeredAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export const offlineQueue = {
  async add(answer: QueuedAnswer) {
    await tx('readwrite', (s) => s.put(answer));
  },
  async remove(key: string) {
    await tx('readwrite', (s) => s.delete(key));
  },
  async list(): Promise<QueuedAnswer[]> {
    const all = await tx<QueuedAnswer[]>('readonly', (s) => s.index('answeredAt').getAll());
    return all;
  },
  async count(): Promise<number> {
    return tx('readonly', (s) => s.count());
  },
  async flush(send: SendAnswer): Promise<{ sent: number; left: number }> {
    let sent = 0;
    for (const a of await offlineQueue.list()) {
      const outcome = await send(a);
      if (outcome === 'retry') break;
      await offlineQueue.remove(a.key);
      if (outcome === 'sent') sent += 1;
    }
    return { sent, left: await offlineQueue.count() };
  },
};
