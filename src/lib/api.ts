export class RequestError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) throw new RequestError(result.error || "The request could not be completed.", response.status, result.code || "REQUEST_FAILED");
  return result as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof RequestError) return error.message;
  if (error instanceof Error && /reject|denied|cancel/i.test(error.message)) return "Wallet request cancelled. Your draft is saved.";
  return "The connection was interrupted. Refresh the status before trying again.";
}
