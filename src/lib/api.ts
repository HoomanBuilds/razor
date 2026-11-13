import { InvalidCompanyTime } from "./company-time";
import { walletFailureMessage } from "./client-errors";

export const SESSION_EXPIRED_EVENT = "razor:session-expired";
export const ACCESS_CHANGED_EVENT = "razor:access-changed";

export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: options?.signal,
  });
  let result;
  try { result = await response.json(); }
  catch {
    throw new RequestError("The server returned an unreadable response. Check the saved status and retry.", response.status, "INVALID_RESPONSE");
  }
  if (!response.ok) {
    const payload = result && typeof result === "object" ? result : {};
    if (typeof window !== "undefined") {
      if (response.status === 401 && payload.code === "UNAUTHENTICATED") window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
      else if (response.status === 403 && ["FORBIDDEN", "COMPANY_ACCESS_DENIED"].includes(payload.code)) window.dispatchEvent(new Event(ACCESS_CHANGED_EVENT));
    }
    throw new RequestError(
      typeof payload.error === "string" ? payload.error : payload.error?.message || "The request could not be completed.",
      response.status,
      payload.code || "REQUEST_FAILED",
    );
  }
  return result as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof RequestError) return error.message;
  if (error instanceof InvalidCompanyTime) return error.message;
  return walletFailureMessage(error);
}
