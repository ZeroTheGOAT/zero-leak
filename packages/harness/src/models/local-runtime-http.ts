/**
 * The HTTP plumbing shared by every request ZeroLeak AI makes to a local
 * inference server: model discovery, residency control, and the per-model
 * connection test. It lives apart from the provider and lifecycle modules so
 * that all three phrase failures identically — an operator reading "Ollama
 * responded 404 Not Found" should not have to work out which subsystem said it.
 *
 * Deliberately not re-exported from the models barrel: this is internal
 * plumbing, not harness API.
 */

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}>;

/**
 * A metadata request to a loopback server either answers at once or is not
 * listening. Four seconds keeps a settings page responsive when a runtime is
 * switched off.
 */
export const LOCAL_METADATA_TIMEOUT_MS = 4_000;

/**
 * A completion, unlike metadata, may have to load weights from disk first. Two
 * minutes is long enough for a large quantised model on a cold page cache and
 * short enough that a wedged server is still reported rather than hung on.
 */
export const LOCAL_COMPLETION_TIMEOUT_MS = 120_000;

/**
 * Loading weights on request is the slowest thing a local runtime does, and it
 * scales with model size rather than with anything ZeroLeak AI controls.
 */
export const LOCAL_LOAD_TIMEOUT_MS = 300_000;

export function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlashes(baseUrl)}/${path.replace(/^\/+/, "")}`;
}

/**
 * Ollama serves its OpenAI-compatible surface under `/v1` but its native
 * catalog and model pool under `/api`, so both have to climb back to the root.
 */
export function nativeRootUrl(baseUrl: string): string {
  return trimTrailingSlashes(baseUrl).replace(/\/v1$/, "");
}

export function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A failure phrased for an operator rather than a developer. A timeout and an
 * abort are the same thing from the caller's side — nothing answered — so they
 * read the same.
 */
export function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError"
      ? "No response before the timeout elapsed."
      : error.message;
  }
  return String(error);
}

export interface LocalHttpRequest {
  /** Name used in the failure message; the runtime's display name. */
  label: string;
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  /** Bearer token, when the runtime is configured to require one. */
  apiKey?: string | undefined;
  body?: unknown;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  fetchImpl?: FetchLike | undefined;
}

/**
 * One JSON request to a local runtime. Rejects with the runtime's own name in
 * the message on a non-2xx response, so every caller can hand the message
 * straight to the UI without composing one of its own.
 */
export async function requestLocalJson(
  url: string,
  request: LocalHttpRequest,
): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...request.headers,
  };
  if (request.body !== undefined) headers["content-type"] = "application/json";
  if (request.apiKey) headers.authorization = `Bearer ${request.apiKey}`;
  const fetchImpl = request.fetchImpl ?? (fetch as unknown as FetchLike);
  const response = await fetchImpl(url, {
    ...(request.method ? { method: request.method } : {}),
    headers,
    ...(request.body === undefined
      ? {}
      : { body: JSON.stringify(request.body) }),
    signal: withTimeout(
      request.signal,
      request.timeoutMs ?? LOCAL_METADATA_TIMEOUT_MS,
    ),
  });
  if (!response.ok) {
    throw new Error(
      `${request.label} responded ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}
