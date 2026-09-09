import { afterEach, beforeEach, expect, it, vi } from 'vitest';

class Stream {
  static CLOSED = 2;
  static instances: Stream[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close = vi.fn();
  constructor(public url: string) { Stream.instances.push(this); }
}
beforeEach(() => {
  vi.resetModules();
  Stream.instances = [];
  vi.stubGlobal('EventSource', Stream);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { vi.unstubAllGlobals(); });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

it.each([null, [], 'wrong server', 42, {}])('rejects a malformed HTTP envelope (%j) as unavailable', async (body) => {
  const { call, CoreUnavailable } = await import('../src/services/transport');
  vi.mocked(fetch).mockResolvedValue(response(body));
  await expect(call('model_list')).rejects.toBeInstanceOf(CoreUnavailable);
});
it('refuses HTTP failures even when a body claims success', async () => {
  const { call } = await import('../src/services/transport');
  vi.mocked(fetch).mockResolvedValue(response({ ok: true, data: 'wrong' }, 500));
  await expect(call('turn_start')).rejects.toThrow('HTTP 500');
});
it('provides launch-link recovery instructions after authentication expires', async () => {
  const { call, CoreUnavailable } = await import('../src/services/transport');
  vi.mocked(fetch).mockResolvedValue(response({ ok: false, error: 'Unauthorized' }, 401));
  await expect(call('core_status')).rejects.toBeInstanceOf(CoreUnavailable);
  await expect(call('core_status')).rejects.toThrow('link this launch printed');
});
it('accepts native void responses and adds deadlines only to availability probes', async () => {
  const { call } = await import('../src/services/transport');
  vi.mocked(fetch).mockImplementation(async () => response({ ok: true, data: null }));
  await expect(call('permission_respond')).resolves.toBeNull();
  expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBeUndefined();
  await call('core_status');
  expect(vi.mocked(fetch).mock.calls[1][1]?.signal).toBeDefined();
});
it('shares one stream, ignores malformed messages, and closes when the last subscriber leaves', async () => {
  const { on } = await import('../src/services/transport');
  const received = vi.fn();
  const removeFirst = await on('agent://text', received);
  const removeLast = await on('agent://done', vi.fn());
  expect(Stream.instances).toHaveLength(1);
  const stream = Stream.instances[0];
  for (const data of ['null', '[]', 'invalid', '42']) expect(() => stream.onmessage?.({ data })).not.toThrow();
  stream.onmessage?.({ data: JSON.stringify({ event: 'agent://text', payload: { delta: 'Hello' } }) });
  expect(received).toHaveBeenCalledWith({ delta: 'Hello' });
  removeFirst();
  expect(stream.close).not.toHaveBeenCalled();
  removeLast();
  expect(stream.close).toHaveBeenCalledOnce();
});
it('reports disconnection and resynchronizes after a manual reconnect opens a closed stream', async () => {
  const { on, call } = await import('../src/services/transport');
  const lost = vi.fn(); const resync = vi.fn();
  window.addEventListener('sovereign:connection-lost', lost);
  window.addEventListener('sovereign:resync', resync);
  const remove = await on('agent://done', vi.fn());
  const stream = Stream.instances[0]; stream.readyState = Stream.CLOSED;
  stream.onerror?.();
  expect(lost).toHaveBeenCalledOnce();
  vi.mocked(fetch).mockResolvedValue(response({ ok: true, data: { state: 'connected' } }));
  await call('core_status');
  expect(Stream.instances).toHaveLength(2);
  Stream.instances[1].onopen?.();
  expect(resync).toHaveBeenCalledOnce();
  remove();
  window.removeEventListener('sovereign:connection-lost', lost);
  window.removeEventListener('sovereign:resync', resync);
});
