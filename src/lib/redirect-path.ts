export function localRedirect(value: unknown, fallback = "/") {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const url = new URL(value, "https://razor.invalid");
    return url.origin === "https://razor.invalid" ? url.pathname + url.search + url.hash : fallback;
  } catch { return fallback; }
}
