// DNS-rebinding guard: a page on another site can point its own hostname at 127.0.0.1, but the browser then
// still sends that hostname in the Host header. Only these local Host values are accepted on guarded paths.

/** Paths that carry live office events or Grok Bot transcripts. */
export const HOST_GUARDED_PREFIXES = ['/api/stream', '/api/live-control'];

/** `127.0.0.1:<digits>` or `localhost:<digits>` (case-insensitive). Anything else, including IPv6, is rejected. */
export function isLocalHost(host: unknown): boolean {
  return typeof host === 'string' && /^(127\.0\.0\.1|localhost):\d{1,5}$/i.test(host);
}

export const hostGuarded = (url: string) => HOST_GUARDED_PREFIXES.some((p) => url.startsWith(p));
