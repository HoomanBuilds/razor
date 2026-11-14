export class DestinationFailure extends Error {}
export class DestinationUnavailable extends Error {}
export function requireDestination(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new DestinationFailure(message);
}
export function selectedRpc(value: string) {
  const url = new URL(value);
  if (
    url.href.length > 2048 ||
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new DestinationUnavailable(
      "Select HTTPS RPC or explicit loopback HTTP without embedded credentials. No endpoint fallback is used.",
    );
  return url;
}
export function boundedDestinationFetch(
  endpoint: string,
  transport: typeof fetch = fetch,
): typeof fetch {
  const selected = selectedRpc(endpoint),
    limit = 2 * 1024 * 1024;
  let calls = 0,
    total = 0;
  return async (input, init) => {
    if (++calls > 20)
      throw new DestinationUnavailable(
        "The bounded RPC request budget was exhausted",
      );
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.href !== selected.href)
      throw new DestinationUnavailable(
        "The verifier did not authorize this RPC endpoint",
      );
    const response = await transport(selected, {
      ...init,
      method: "POST",
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(12000)])
        : AbortSignal.timeout(12000),
      cache: "no-store",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DestinationUnavailable(
        "The selected RPC is unavailable or rate limited. No retry or endpoint fallback was attempted.",
      );
    }
    const size = Number(response.headers.get("content-length"));
    if (Number.isFinite(size) && size > limit) {
      await response.body?.cancel();
      throw new DestinationUnavailable("The RPC response exceeds 2 MB");
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new DestinationUnavailable(
        "The selected RPC returned no response body",
      );
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        total += item.value.byteLength;
        if (bytes > limit || total > 8 * 1024 * 1024)
          throw new DestinationUnavailable(
            "The RPC response exceeds the bounded local verification budget",
          );
        chunks.push(item.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
export function destinationRpc(
  endpoint: string,
  transport: typeof fetch = fetch,
) {
  const bounded = boundedDestinationFetch(endpoint, transport);
  let id = 0;
  return async <T>(method: string, params: unknown): Promise<T> => {
    const response = await bounded(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const body = (await response.json()) as { result?: T; error?: unknown };
    if (body.error || !("result" in body))
      throw new DestinationUnavailable(
        "The selected RPC cannot supply the required historical or finalized evidence",
      );
    return body.result as T;
  };
}
