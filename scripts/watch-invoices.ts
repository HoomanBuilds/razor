import { constants } from "node:fs";
import { open, opendir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, parse, resolve } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const maxBytes = 3 * 1024 * 1024;
const types: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };
export async function readAllowedInvoiceFolder(folder: string, allowReadFolder: string, visit: (file: { filename: string; mediaType: string; bytes: Buffer; hash: string }) => Promise<void>) {
  if (process.platform !== "linux") throw new Error("The safe folder connector currently requires Linux");
  if (!isAbsolute(folder) || folder !== resolve(folder) || allowReadFolder !== folder) throw new Error("Explicit permission requires --folder and --allow-read-folder with the same absolute directory");
  if (await realpath(folder) !== folder) throw new Error("The allowed folder must not contain symlinks");
  let directory = await open(parse(folder).root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const name of folder.slice(parse(folder).root.length).split("/").filter(Boolean)) {
      const child = await open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close(); directory = child;
    }
    if (await realpath(`/proc/self/fd/${directory.fd}`) !== folder) throw new Error("The allowed folder changed during access verification");
  } catch (error) { await directory.close(); throw error; }
  let scanned = 0, eligible = 0;
  try {
    const handle = await opendir(`/proc/self/fd/${directory.fd}`);
    for await (const entry of handle) {
      if (++scanned > 100) break;
      if (!entry.isFile() || entry.isSymbolicLink() || basename(entry.name) !== entry.name) continue;
      const mediaType = types[entry.name.split(".").at(-1)?.toLowerCase() ?? ""];
      if (!mediaType) continue;
      const file = await open(`/proc/self/fd/${directory.fd}/${entry.name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size < 1 || before.size > maxBytes || before.nlink !== 1) continue;
        const bytes = Buffer.alloc(before.size); let read = 0;
        while (read < bytes.length) { const result = await file.read(bytes, read, bytes.length - read, read); if (!result.bytesRead) break; read += result.bytesRead; }
        const after = await file.stat();
        if (read !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) continue;
        await visit({ filename: entry.name, mediaType, bytes, hash: createHash("sha256").update(bytes).digest("hex") });
        eligible++;
      } finally { await file.close(); }
    }
  } finally { await directory.close(); }
  return { scanned: Math.min(scanned, 100), eligible, capped: scanned > 100 };
}

export async function watchInvoiceFolder(args = process.argv.slice(2), transport = globalThis.fetch) {
  const option = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";
  const folder = option("folder"), allow = option("allow-read-folder"), endpoint = new URL(option("endpoint")), token = process.env.RAZOR_INVOICE_FOLDER_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Set the intake-only RAZOR_INVOICE_FOLDER_TOKEN issued by the company owner");
  if (!(endpoint.protocol === "https:" || endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^\/api\/invoice-ingress\/[a-f0-9-]+\/upload$/.test(endpoint.pathname)) throw new Error("Use the exact HTTPS folder upload endpoint supplied by Razor");
  const headers = { Authorization: `Bearer ${token}` };
  const request = async (url: URL, options: RequestInit) => {
    const response = await transport(url, { ...options, redirect: "error", signal: AbortSignal.timeout(60000) });
    if ([401, 403].includes(response.status)) throw new Error("Folder access was revoked or its company permissions changed");
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { if (reader) while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 32768) throw new Error("The folder connector response exceeded its size limit"); chunks.push(chunk.value); } }
    finally { await reader?.cancel(); }
    return { response, body: size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as { event?: { status: string; nextAttemptAt: string; attempts: number }; error?: string } : {} };
  };
  let stopped = false;
  const stop = () => { stopped = true; }; process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    do {
      const result = await readAllowedInvoiceFolder(folder, allow, async file => {
        const statusUrl = new URL(endpoint); statusUrl.pathname = statusUrl.pathname.replace(/\/upload$/, `/events/${file.hash}`);
        const status = await request(statusUrl, { headers });
        if (status.response.ok && status.body.event && (["received", "expired", "revoked", "processing"].includes(status.body.event.status) || status.body.event.attempts >= 6 || status.body.event.status === "failed" && status.body.event.nextAttemptAt > new Date().toISOString())) return;
        if (!status.response.ok && status.response.status !== 404) throw new Error(status.body.error ?? "Could not inspect the saved folder event");
        const body = new FormData(); body.set("file", new File([new Uint8Array(file.bytes)], file.filename, { type: file.mediaType }));
        const uploaded = await request(endpoint, { method: "POST", headers: { ...headers, "X-Invoice-Event-Id": file.hash }, body });
        if (!uploaded.response.ok) console.error(JSON.stringify({ hash: file.hash, status: "retry_required", error: uploaded.body.error ?? "Upload failed" }));
        else console.info(JSON.stringify({ hash: file.hash, status: uploaded.body.event?.status ?? "saved" }));
      });
      console.info(JSON.stringify({ ...result, status: "scan_complete" }));
      if (args.includes("--once") || stopped) break;
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); process.removeListener("SIGTERM", wake); process.removeListener("SIGINT", wake); resolve(); };
        const timer = setTimeout(wake, 15000);
        process.once("SIGTERM", wake); process.once("SIGINT", wake);
      });
    } while (!stopped);
  } finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  watchInvoiceFolder().catch(error => { console.error(error instanceof Error ? error.message : "The folder connector stopped"); process.exitCode = 1; });
}
