import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { ApiError } from "../context";

export type ProviderTransport = (url: URL, headers: Record<string, string>, maxBytes: number) => Promise<Buffer>;
const hosts = new Set(["api.telegram.org", "graph.facebook.com", "lookaside.fbsbx.com"]);

export function safeProviderUrl(value: string | URL) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !hosts.has(url.hostname) || url.username || url.password || url.port && url.port !== "443" || url.hash) throw new ApiError(422, "The provider returned an unsafe download address", "CHANNEL_URL_REJECTED");
  return url;
}

export function publicProviderAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19, 51].includes(b) || a === 203 && b === 0 || a >= 224);
  }
  if (isIP(address) === 6) return /^[23][0-9a-f]{0,3}:/i.test(address) && !/^2001:(?:db8|0|10|20):/i.test(address) && !/^2002:/i.test(address);
  return false;
}

export const providerTransport: ProviderTransport = async (value, headers, maxBytes) => {
  const url = safeProviderUrl(value);
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([lookup(url.hostname, { all: true, verbatim: true }), new Promise<never>((_, reject) => { dnsTimer = setTimeout(() => reject(new ApiError(503, "Provider DNS lookup timed out", "CHANNEL_PROVIDER_UNAVAILABLE")), 5000); dnsTimer.unref(); })]).finally(() => clearTimeout(dnsTimer));
  if (!addresses.length || addresses.some(item => !publicProviderAddress(item.address))) throw new ApiError(422, "The provider resolved to an unsafe network address", "CHANNEL_URL_REJECTED");
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(url, { headers, family: address.family, lookup: (_host, _options, done) => done(null, address.address, address.family), timeout: 15_000 }, response => {
      if (response.statusCode !== 200) { response.destroy(); reject(new ApiError(503, "The provider could not deliver this file. Retry or upload it manually", "CHANNEL_PROVIDER_UNAVAILABLE")); return; }
      const declared = response.headers["content-length"];
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) { response.destroy(); reject(new ApiError(413, "The provider file exceeds its size limit", "CHANNEL_FILE_TOO_LARGE")); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { response.destroy(new ApiError(413, "The provider file exceeds its size limit", "CHANNEL_FILE_TOO_LARGE")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve(Buffer.concat(chunks, size)));
    });
    const timer = setTimeout(() => req.destroy(new ApiError(503, "Provider download timed out", "CHANNEL_PROVIDER_UNAVAILABLE")), 20_000);
    timer.unref();
    req.on("close", () => clearTimeout(timer));
    req.on("timeout", () => req.destroy(new ApiError(503, "Provider download timed out", "CHANNEL_PROVIDER_UNAVAILABLE")));
    req.on("error", error => reject(error instanceof ApiError ? error : new ApiError(503, "The provider could not deliver this file. Retry or upload it manually", "CHANNEL_PROVIDER_UNAVAILABLE")));
    req.end();
  });
};
