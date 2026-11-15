export const DEMO_STATE_EVENT = "razor:demo-state";
export const DEMO_NOTICE_EVENT = "razor:demo-notice";

export function isPublicDemo(pathname = typeof window === "undefined" ? "" : window.location.pathname) {
  return pathname === "/demo" || pathname.startsWith("/demo/");
}

export function appHref(href: string): string {
  if (!isPublicDemo() || typeof window === "undefined" || href.startsWith("#")) return href;
  const url = new URL(href, window.location.origin);
  if (url.origin !== window.location.origin && !(["razorfi.xyz", "www.razorfi.xyz"].includes(url.hostname) && url.pathname === "/receive")) return href;
  if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/demo/")) return `/api/demo/workspace/api/${url.pathname.slice(5)}${url.search}${url.hash}`;
  const kind = ({ "/app": "company", "/receive": "receive", "/account": "account" } as Record<string, string>)[url.pathname];
  if (!kind) return href;
  const current = new URLSearchParams(window.location.search), profile = url.searchParams.get("profile") || current.get("profile") || "owner";
  url.pathname = "/demo";
  url.searchParams.set("kind", kind);
  url.searchParams.set("profile", kind === "company" ? "owner" : kind === "receive" && profile === "owner" ? "maya" : profile);
  if(kind==="company"&&url.searchParams.get("section")==="payroll"&&current.get("section")==="payroll"&&url.searchParams.get("company")===current.get("company")&&!url.searchParams.has("reviewRun")&&current.has("reviewRun"))url.searchParams.set("reviewRun",current.get("reviewRun")!);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function demoRequestHeaders(headers?: HeadersInit, profile = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("profile")) {
  const result = new Headers(headers);
  result.delete("x-razor-demo-profile");
  if (isPublicDemo() && profile && ["owner", "maya", "leo"].includes(profile)) result.set("x-razor-demo-profile", profile);
  return result;
}

export function appFetch(input: RequestInfo | URL, init?: RequestInit) {
  if (!isPublicDemo()) return fetch(input, init);
  const mapped = appHref(input instanceof Request ? input.url : String(input));
  const target = new URL(mapped, window.location.origin);
  const scoped = target.origin === window.location.origin && target.pathname.startsWith("/api/demo/workspace/");
  const options = scoped ? { ...init, headers: demoRequestHeaders(init?.headers ?? (input instanceof Request ? input.headers : undefined)) } : init;
  if (input instanceof Request) return fetch(new Request(target, input), options);
  return fetch(mapped, options);
}

export function requireLiveWallet() {
  if (isPublicDemo()) throw new Error("Wallet signing is disabled in the demo. Use the demo payment action.");
}

export function appNavigate(href: string) {
  const target=appHref(href);
  if(isPublicDemo()&&!target.startsWith("/demo")){window.dispatchEvent(new CustomEvent(DEMO_NOTICE_EVENT,{detail:"External actions are unavailable in this demo."}));return;}
  window.location.assign(target);
}
