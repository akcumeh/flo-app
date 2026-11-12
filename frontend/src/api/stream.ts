import { ApiError, API_URL, authedFetch, readProblem } from './http';

export interface SseFrame {
  event: string;
  data: unknown;
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value.replace(/\r\n/g, '\n');
    let cut = buffer.indexOf('\n\n');
    while (cut !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      cut = buffer.indexOf('\n\n');
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length === 0) continue;
      const raw = data.join('\n');
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      yield { event, data: parsed };
    }
  }
}

export async function postStream(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal
): Promise<{ frames: AsyncGenerator<SseFrame> } | { json: unknown }> {
  const req = new Request(`${API_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const res = await authedFetch(req);
  if (!res.ok) throw new ApiError(res.status, await readProblem(res));
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('application/json')) return { json: await res.json() };
  if (!res.body) throw new ApiError(0, null, 'The answer stream did not open.');
  return { frames: readSse(res.body) };
}
