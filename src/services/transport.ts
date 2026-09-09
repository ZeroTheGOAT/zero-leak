/**
 * The two doors into the Rust core, behind one pair of functions.
 *
 * This application runs the same way twice: as a desktop window, where calls go
 * over Zero IPC, and as a page in a browser, where they go over HTTP to
 * `127.0.0.1`. Nothing above this file knows which. `services/core.ts` builds
 * its typed wrappers on `call` and `on`, every component builds on those, and so
 * the entire UI is transport-agnostic without a single conditional outside this
 * module.
 *
 * That symmetry is not a coincidence on the Rust side either. Both transports
 * enter `api::dispatch`, and `AppState::emit` serialises each event once and
 * sends those same bytes to the webview and to the SSE channel. The window and
 * the tab cannot drift apart, because there is nothing to keep in step.
 *
 * ## What the tab can and cannot do
 *
 * It can do everything, including the heavy work. Every expensive operation here
 * already happens in a native process — `llama-server.exe` on CUDA, the sandbox
 * children inside job objects, document parsing and OCR in Rust — and this page
 * only renders text and reads events. A tab therefore reaches the whole machine.
 * What a browser cannot do *by itself* is spawn those processes or read the
 * filesystem, which is why the Zero process is still running underneath even
 * when there is no window: native file pickers, job objects and model launches
 * all live there.
 *
 * ## Errors
 *
 * Zero rejects with the *serialised* error value, and `CoreError` serialises to
 * a string — so the IPC path rejects with a bare string, not an `Error`. The HTTP
 * path returns that same string in a JSON envelope. Both are normalised to a
 * real `Error` here so that every call site can read `e.message` and get the same
 * words whichever door the request went through.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** Re-exported so nothing above this file imports from `@tauri-apps/api`. */
export type { UnlistenFn };

/** Starts a native window drag. Only called after `transport() === 'ipc'`. */
export const startWindowDragging = (): Promise<void> => getCurrentWindow().startDragging();

/* ------------------------------------------------------------------ */
/* Which door                                                          */
/* ------------------------------------------------------------------ */

export type Transport = 'ipc' | 'http';

/**
 * `ipc` inside the desktop window, `http` in a browser tab.
 *
 * Decided by the presence of Zero's injected bridge, which is the only
 * difference the page can actually observe. In `http` mode this says nothing
 * about whether a core is *reachable* — that is what the first call finds out,
 * and an unreachable one produces `CoreUnavailable` rather than a guess.
 */
export function transport(): Transport {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window ? 'ipc' : 'http';
}

/** True in the desktop window, where window controls and drag regions apply. */
export const isDesktopShell = (): boolean => transport() === 'ipc';

/* ------------------------------------------------------------------ */
/* Failure to reach the core at all                                    */
/* ------------------------------------------------------------------ */

/**
 * The core is not there, as distinct from the core refusing something.
 *
 * A command that runs and fails throws a plain `Error` carrying the core's own
 * explanation. This subclass means the request never arrived, so the UI can show
 * a disconnected state instead of an operation failure.
 */
export class CoreUnavailable extends Error {
  readonly command: string;

  constructor(command: string, detail: string) {
    super(`Cannot run "${command}": ${detail}`);
    this.name = 'CoreUnavailable';
    this.command = command;
  }
}

const NO_CORE =
  'nothing on this origin answered. This page is being served by something other ' +
  'than the workbench — a bare `npm run dev` server, for example. Start the ' +
  'application and open the link it prints for the launch.';

const NOT_AUTHORISED =
  'this browser session is not authorised. The session token is issued per launch, ' +
  'so open the workbench using the link this launch printed rather than a saved ' +
  'bookmark.';

/** Turns anything a rejection can carry into an `Error` with a useful message. */
function asError(e: unknown): Error {
  if (e instanceof Error) return e;
  if (typeof e === 'string') return new Error(e);
  return new Error(typeof e === 'object' && e !== null ? JSON.stringify(e) : String(e));
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return transport() === 'ipc' ? viaIpc<T>(command, args) : viaHttp<T>(command, args);
}

/**
 * One Zero command, `invoke_core`, forwards to the shared dispatch table.
 * Forty typed commands would have needed forty matching HTTP routes, and the
 * first one anybody forgot would be a behaviour difference between the window
 * and the tab.
 */
async function viaIpc<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>('invoke_core', { command, args: args ?? {} });
  } catch (e) {
    throw asError(e);
  }
}

async function viaHttp<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api/invoke', {
      method: 'POST',
      // The session cookie is `HttpOnly`, so page script never handles the
      // token; the browser attaches it and nothing here can leak it.
      credentials: 'same-origin',
      cache: 'no-store',
      // Only the availability probe has a deadline. Timing out a write could
      // encourage a duplicate retry after the core already performed it.
      signal: command === 'core_status' ? AbortSignal.timeout(10_000) : undefined,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, args: args ?? {} }),
    });
  } catch {
    // A transport-level failure: no listener, or the core exited.
    throw new CoreUnavailable(command, NO_CORE);
  }

  const unauthorised = res.status === 401 || res.status === 403;

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // Something answered but it was not this application — a dev server's 404
    // page, or a proxy. Say that rather than reporting a command failure.
    throw new CoreUnavailable(command, unauthorised ? NOT_AUTHORISED : NO_CORE);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body) || !('ok' in body)) {
    throw new CoreUnavailable(command, unauthorised ? NOT_AUTHORISED : NO_CORE);
  }
  const envelope = body as { ok?: unknown; data?: unknown; error?: unknown };
  if (res.ok && envelope.ok === true) {
    // A manual reconnect must also reopen a stream which had stopped retrying.
    if (command === 'core_status' && handlers.size > 0) openStream();
    return envelope.data as T;
  }

  const detail = unauthorised ? NOT_AUTHORISED : typeof envelope.error === 'string' ? envelope.error : `The core answered HTTP ${res.status}.`;
  // A rejected guard is an availability problem; a failed command is not.
  throw unauthorised ? new CoreUnavailable(command, detail) : new Error(detail);
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

type Handler = (payload: never) => void;

const handlers = new Map<string, Set<Handler>>();
let source: EventSource | null = null;
let gapped = false;

/**
 * Subscribe to one core event.
 *
 * Over IPC this is Zero's own listener. Over HTTP every event arrives on a
 * single `EventSource`, which is then demultiplexed here — one stream rather
 * than one per channel, because the server emits `{event, payload}` lines from a
 * single broadcast channel and eleven sockets would each carry all of them.
 */
export async function on<P>(event: string, handler: (payload: P) => void): Promise<UnlistenFn> {
  if (transport() === 'ipc') {
    return listen<P>(event, (e) => handler(e.payload));
  }

  const set = handlers.get(event) ?? new Set<Handler>();
  set.add(handler as Handler);
  handlers.set(event, set);
  openStream();

  return () => {
    set.delete(handler as Handler);
    if (set.size === 0) handlers.delete(event);
    if (handlers.size === 0) {
      source?.close();
      source = null;
      gapped = false;
    }
  };
}

function fanOut(event: string, payload: unknown): void {
  const set = handlers.get(event);
  if (!set) return;
  for (const h of set) {
    try {
      (h as (p: unknown) => void)(payload);
    } catch (e) {
      // One bad handler must not stop the rest of the stream.
      console.error(`[sovereign] handler for ${event} threw:`, e);
    }
  }
}

function openStream(): void {
  if (source) return;

  const es = new EventSource('/api/events');
  source = es;

  es.onopen = () => {
    if (source !== es) return;
    if (!gapped) return;
    gapped = false;
    // The core's broadcast channel has no replay, so anything emitted while the
    // stream was down is gone.
    resync('the event stream reconnected after a break');
  };

  es.onmessage = (e) => {
    if (source !== es) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const msg = parsed as { event?: unknown; payload?: unknown };
    if (typeof msg.event !== 'string') return;

    // The server sends this when it had to drop events for a slow receiver —
    // browsers throttle background tabs, and `agent://text` is one event per
    // token. It is a hole in the stream, reported rather than hidden.
    if (msg.event === 'core://resync') {
      const dropped = (msg.payload as { dropped?: number } | null)?.dropped;
      resync(`the core dropped ${dropped ?? 'some'} events for this tab`);
      return;
    }

    fanOut(msg.event, msg.payload);
  };

  es.onerror = () => {
    if (source !== es) return;
    if (!gapped) {
      window.dispatchEvent(new CustomEvent('sovereign:connection-lost'));
    }
    gapped = true;
    // `EventSource` reconnects by itself; `CLOSED` means it gave up, which in
    // practice means the session was rejected.
    if (es.readyState === EventSource.CLOSED) {
      source = null;
      console.error(
        '[sovereign] The event stream closed and will not retry. Reopen the workbench ' +
          'using the link this launch printed.',
      );
      return;
    }
  };
}

/**
 * Tell the UI to re-read everything the core owns.
 *
 * Deliberately not `location.reload()`. A reload during a run would discard the
 * streamed answer text, which the core does not re-send — losing visible work to
 * recover from a gap in telemetry is the wrong trade. `AppContext` listens for
 * this and re-runs its hydration instead.
 */
function resync(reason: string): void {
  console.warn(`[sovereign] ${reason}; re-reading state from the core.`);
  window.dispatchEvent(new CustomEvent('sovereign:resync', { detail: { reason } }));
}
