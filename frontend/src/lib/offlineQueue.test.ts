import 'fake-indexeddb/auto';
import { offlineQueue, type QueuedAnswer } from './offlineQueue';

const answer = (key: string, at: string): QueuedAnswer => ({ key, sessionId: 's1', itemId: 0, answer: 'B', answeredAt: at });

describe('offline answer queue', () => {
  beforeEach(async () => {
    for (const a of await offlineQueue.list()) await offlineQueue.remove(a.key);
  });

  it('keeps answers in the order they were answered, with their keys and times', async () => {
    await offlineQueue.add(answer('k2', '2026-11-12T09:01:00Z'));
    await offlineQueue.add(answer('k1', '2026-11-12T09:00:00Z'));
    expect((await offlineQueue.list()).map((a) => a.key)).toEqual(['k1', 'k2']);
  });

  it('sends in order, drops answers the server refuses, and stops at the first retry', async () => {
    await offlineQueue.add(answer('a', '2026-11-12T09:00:00Z'));
    await offlineQueue.add(answer('b', '2026-11-12T09:01:00Z'));
    await offlineQueue.add(answer('c', '2026-11-12T09:02:00Z'));
    const seen: string[] = [];
    const result = await offlineQueue.flush(async (a) => {
      seen.push(a.key);
      return a.key === 'a' ? 'sent' : a.key === 'b' ? 'drop' : 'retry';
    });
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(result).toEqual({ sent: 1, left: 1 });
    expect((await offlineQueue.list()).map((a) => a.key)).toEqual(['c']);
  });
});
