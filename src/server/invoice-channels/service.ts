import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt, hashToken, newToken } from "../identity/crypto";
import { audit, getAccess } from "../identity/session";
import { DOCUMENT_LIMITS, documentFilename, documentRetentionDays, validateDocument, withDocumentIngress } from "../document-intake/limits";
import { uploadDocument } from "../document-intake/service";
import { providerTransport, safeProviderUrl, type ProviderTransport } from "./transport";

const stamp = () => new Date().toISOString();
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const numericId = z.string().regex(/^\d{1,30}$/);
const base = { label: z.string().trim().min(1).max(80), privacyAcknowledged: z.literal(true) };
export const connectionInput = z.discriminatedUnion("provider", [
  z.object({ ...base, provider: z.literal("telegram"), botId: numericId, chatId: z.string().regex(/^-?\d{1,30}$/), senderId: numericId, botToken: z.string().max(200).default("") }).strict(),
  z.object({ ...base, provider: z.literal("whatsapp"), businessAccountId: numericId, phoneNumberId: numericId, senderId: numericId, graphVersion: z.string().regex(/^v\d{1,3}\.0$/), accessToken: z.string().max(4096).default(""), appSecret: z.string().max(200).default("") }).strict(),
  z.object({ ...base, provider: z.literal("folder") }).strict(),
]);
type Provider = "telegram" | "whatsapp" | "folder";
interface Channel {
  id: string; organization_id: string; created_by: string; provider: Provider; label: string; config_ciphertext: string; secrets_ciphertext: string | null;
  credential_hash: string | null; authorized_at: string; challenge_verified_at: string | null; verified_at: string | null; last_received_at: string | null; revoked_at: string | null; created_at: string;
}
interface Source { filename: string; mediaType: string; mediaId?: string; senderId?: string; chatId?: string; messageId?: string; providerTimestamp?: string; contentHash?: string; declaredBytes?: number }
interface Event { id: string; organization_id: string; channel_id: string; event_key: string; payload_hash: string; source_ciphertext: string | null; status: string; attempts: number; processing_token: string | null; next_attempt_at: string; error_code: string | null; document_id: string | null; created_at: string; updated_at: string; expires_at: string }
type Config = { botId?: string; chatId?: string; senderId?: string; phoneNumberId?: string; businessAccountId?: string; graphVersion?: string };
type Secrets = { webhookSecret?: string; botToken?: string; accessToken?: string; appSecret?: string; verifyToken?: string };
const configOf = (channel: Channel): Config => JSON.parse(decrypt(channel.config_ciphertext));
const secretsOf = (channel: Channel): Secrets => channel.secrets_ciphertext ? JSON.parse(decrypt(channel.secrets_ciphertext)) : {};
let working = false;

export const withInvoiceIngress = withDocumentIngress;

function manager(access: AccessContext) { requirePermission(access, "company:manage"); requirePermission(access, "documents:manage"); }
function owner(access: AccessContext) {
  manager(access);
  if (!row("SELECT id FROM organizations WHERE id=? AND owner_id=?", access.organizationId, access.userId)) throw new ApiError(403, "The company owner must authorize this inbox binding", "CHANNEL_OWNER_REQUIRED");
}
function find(id: string) {
  const value = row<Channel>("SELECT * FROM invoice_channels WHERE id=?", id);
  if (!value || value.revoked_at) throw new ApiError(401, "This invoice connection is unavailable or revoked", "CHANNEL_UNAVAILABLE");
  return value;
}
function companyChannel(access: AccessContext, id: string) {
  manager(access);
  const channel = row<Channel>("SELECT * FROM invoice_channels WHERE id=? AND organization_id=?", id, access.organizationId);
  if (!channel) throw new ApiError(404, "Invoice connection not found", "CHANNEL_NOT_FOUND");
  return channel;
}
export function channelAccess(channel: Channel) {
  const access = getAccess(channel.created_by, channel.organization_id);
  requirePermission(access, "company:read"); requirePermission(access, "documents:manage");
  return access;
}
function projection(channel: Channel) {
  const config = configOf(channel), secrets = secretsOf(channel);
  const missing = channel.provider === "telegram" ? !secrets.botToken ? ["Telegram bot token"] : [] : channel.provider === "whatsapp" ? [...(!secrets.accessToken ? ["Meta access token"] : []), ...(!secrets.appSecret ? ["Meta app secret"] : [])] : [];
  return { id: channel.id, provider: channel.provider, label: channel.label, config, status: channel.revoked_at ? "revoked" : missing.length ? "setup_required" : channel.verified_at ? "verified_input_received" : "awaiting_verified_input", missing, authorizedAt: channel.authorized_at, challengeVerifiedAt: channel.challenge_verified_at, verifiedAt: channel.verified_at, lastReceivedAt: channel.last_received_at, revokedAt: channel.revoked_at, createdAt: channel.created_at, webhookPath: channel.provider === "folder" ? null : `/api/invoice-ingress/${channel.id}/${channel.provider}`, uploadPath: channel.provider === "folder" ? `/api/invoice-ingress/${channel.id}/upload` : null };
}
function eventProjection(event: Event) {
  return { id: event.id, channelId: event.channel_id, eventKey: event.event_key, status: event.status, attempts: event.attempts, errorCode: event.error_code, documentId: event.document_id, source: event.source_ciphertext ? JSON.parse(decrypt(event.source_ciphertext)) as Source : null, nextAttemptAt: event.next_attempt_at, createdAt: event.created_at, expiresAt: event.expires_at };
}
export function listInvoiceChannels(access: AccessContext) {
  manager(access); purgeInvoiceChannelRetention();
  return { canAuthorize: !!row("SELECT id FROM organizations WHERE id=? AND owner_id=?", access.organizationId, access.userId), channels: rows<Channel>("SELECT * FROM invoice_channels WHERE organization_id=? ORDER BY (revoked_at IS NOT NULL),created_at DESC LIMIT 50", access.organizationId).map(projection), events: rows<Event>("SELECT * FROM invoice_channel_events WHERE organization_id=? ORDER BY created_at DESC,id DESC LIMIT 50", access.organizationId).map(eventProjection), privacy: "Telegram and Meta can see documents sent through their services. Razor receives plaintext for bounded ingestion and stores originals encrypted in the same human review queue. A folder connector reads only the directory explicitly allowed on your computer. Manual browser upload remains available. Intake never approves or pays an invoice." };
}
export function createInvoiceChannel(access: AccessContext, input: z.input<typeof connectionInput>) {
  owner(access);
  const parsed = connectionInput.parse(input), id = randomUUID(), createdAt = stamp();
  const secrets: Secrets = {}, config: Config = {};
  let credential: string | null = null, binding = id;
  if (parsed.provider === "telegram") {
    if (parsed.botToken && !new RegExp(`^${parsed.botId}:[A-Za-z0-9_-]{20,150}$`).test(parsed.botToken)) throw new ApiError(422, "The bot token must belong to the configured Telegram bot", "CHANNEL_TOKEN_INVALID");
    Object.assign(config, { botId: parsed.botId, chatId: parsed.chatId, senderId: parsed.senderId });
    Object.assign(secrets, { botToken: parsed.botToken, webhookSecret: newToken() }); binding = parsed.botId;
  } else if (parsed.provider === "whatsapp") {
    Object.assign(config, { businessAccountId: parsed.businessAccountId, phoneNumberId: parsed.phoneNumberId, senderId: parsed.senderId, graphVersion: parsed.graphVersion });
    Object.assign(secrets, { accessToken: parsed.accessToken, appSecret: parsed.appSecret, verifyToken: newToken() }); binding = parsed.phoneNumberId;
  } else credential = newToken();
  transaction(db => {
    if (row<{ count: number }>("SELECT COUNT(*) AS count FROM invoice_channels WHERE organization_id=? AND revoked_at IS NULL", access.organizationId)!.count >= 10) throw new ApiError(422, "Revoke unused inbox connections before adding another", "CHANNEL_LIMIT");
    if (parsed.provider !== "folder" && row("SELECT id FROM invoice_channels WHERE provider=? AND binding_hash=? AND revoked_at IS NULL", parsed.provider, digest(binding))) throw new ApiError(409, "This provider inbox already has an active company binding", "CHANNEL_ALREADY_BOUND");
    db.prepare("INSERT INTO invoice_channels(id,organization_id,created_by,provider,label,config_ciphertext,secrets_ciphertext,credential_hash,binding_hash,authorized_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, access.organizationId, access.userId, parsed.provider, parsed.label, encrypt(JSON.stringify(config)), parsed.provider === "folder" ? null : encrypt(JSON.stringify(secrets)), credential ? hashToken(credential) : null, digest(binding), createdAt, createdAt);
    audit(access.userId, access.organizationId, "invoice_channel.authorized", id, { provider: parsed.provider });
  });
  return { channel: projection(find(id)), setup: { credential, webhookSecret: secrets.webhookSecret ?? null, verifyToken: secrets.verifyToken ?? null } };
}
export function replaceChannelSecrets(access: AccessContext, id: string, input: { botToken?: string; accessToken?: string; appSecret?: string }) {
  owner(access); const channel = companyChannel(access, id); find(id);
  const config = configOf(channel), secrets = secretsOf(channel);
  if (channel.provider === "telegram") {
    if (!input.botToken || !new RegExp(`^${config.botId}:[A-Za-z0-9_-]{20,150}$`).test(input.botToken)) throw new ApiError(422, "Enter the token for this configured Telegram bot", "CHANNEL_TOKEN_INVALID");
    secrets.botToken = input.botToken;
  } else if (channel.provider === "whatsapp") {
    if (!input.accessToken || !input.appSecret) throw new ApiError(422, "Enter the Meta access token and app secret", "CHANNEL_TOKEN_INVALID");
    secrets.accessToken = input.accessToken; secrets.appSecret = input.appSecret;
  } else throw new ApiError(422, "Rotate the folder ingestion credential instead", "CHANNEL_PROVIDER_INVALID");
  getDb().prepare("UPDATE invoice_channels SET secrets_ciphertext=?,verified_at=NULL,challenge_verified_at=NULL WHERE id=?").run(encrypt(JSON.stringify(secrets)), id);
  audit(access.userId, access.organizationId, "invoice_channel.credentials_updated", id);
  return { channel: projection(find(id)) };
}
export function rotateChannelCredential(access: AccessContext, id: string) {
  owner(access); const channel = companyChannel(access, id); find(id);
  const token = newToken(), secrets = secretsOf(channel);
  if (channel.provider === "folder") getDb().prepare("UPDATE invoice_channels SET credential_hash=? WHERE id=?").run(hashToken(token), id);
  else { secrets[channel.provider === "telegram" ? "webhookSecret" : "verifyToken"] = token; getDb().prepare("UPDATE invoice_channels SET secrets_ciphertext=?,verified_at=NULL,challenge_verified_at=NULL WHERE id=?").run(encrypt(JSON.stringify(secrets)), id); }
  audit(access.userId, access.organizationId, "invoice_channel.credential_rotated", id);
  return { credential: token, channel: projection(find(id)) };
}
export function revokeInvoiceChannel(access: AccessContext, id: string) {
  const channel = companyChannel(access, id);
  transaction(db => {
    db.prepare("UPDATE invoice_channels SET revoked_at=COALESCE(revoked_at,?),secrets_ciphertext=NULL,credential_hash=NULL WHERE id=?").run(stamp(), id);
    db.prepare("UPDATE invoice_channel_events SET status='revoked',source_ciphertext=NULL,processing_token=NULL,updated_at=? WHERE channel_id=? AND status IN ('queued','processing','failed')").run(stamp(), id);
    audit(access.userId, access.organizationId, "invoice_channel.revoked", id, { provider: channel.provider });
  });
  return { revoked: true };
}
export function authenticateFolder(id: string, bearer: string | undefined) {
  const channel = find(id);
  if (channel.provider !== "folder" || !bearer?.startsWith("Bearer ") || !channel.credential_hash || !safeEqual(hashToken(bearer.slice(7)), channel.credential_hash)) throw new ApiError(401, "An active folder ingestion credential is required", "CHANNEL_CREDENTIAL_INVALID");
  return { channel, access: channelAccess(channel) };
}
function safeEqual(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export function authenticateProvider(id: string, provider: "telegram" | "whatsapp", secret?: string) {
  const channel = find(id); if (channel.provider !== provider) throw new ApiError(401, "Incorrect invoice provider", "CHANNEL_PROVIDER_INVALID");
  channelAccess(channel);
  const secrets = secretsOf(channel);
  if (provider === "telegram" && (!secrets.botToken || !secret || !safeEqual(secret, secrets.webhookSecret ?? ""))) throw new ApiError(401, "Telegram webhook authentication failed", "CHANNEL_SIGNATURE_INVALID");
  if (provider === "whatsapp" && (!secrets.appSecret || !secrets.accessToken)) throw new ApiError(503, "Complete the Meta credentials before receiving invoices", "CHANNEL_SETUP_REQUIRED");
  return channel;
}
export function verifyWhatsAppChallenge(id: string, mode?: string, token?: string, challenge?: string) {
  const channel = authenticateProvider(id, "whatsapp"), secrets = secretsOf(channel);
  if (mode !== "subscribe" || !token || !safeEqual(token, secrets.verifyToken ?? "") || !challenge || !/^\d{1,200}$/.test(challenge)) throw new ApiError(403, "Meta webhook challenge verification failed", "CHANNEL_CHALLENGE_INVALID");
  getDb().prepare("UPDATE invoice_channels SET challenge_verified_at=? WHERE id=?").run(stamp(), id);
  return challenge;
}
function enqueue(channel: Channel, eventKey: string, source: Source) {
  const serialized = JSON.stringify(source), payloadHash = digest(serialized);
  return transaction(db => {
    const existing = row<Event>("SELECT * FROM invoice_channel_events WHERE channel_id=? AND event_key=?", channel.id, eventKey);
    if (existing) {
      if (channel.provider !== "folder" && existing.payload_hash !== payloadHash) throw new ApiError(409, "A provider event ID was reused with different content", "CHANNEL_EVENT_CHANGED");
      return { duplicate: true, event: eventProjection(existing) };
    }
    if (row<{ count: number }>("SELECT COUNT(*) AS count FROM invoice_channel_events WHERE organization_id=?", channel.organization_id)!.count >= 1000) throw new ApiError(429, "The invoice event inbox is full. Retry after retention cleanup", "CHANNEL_EVENT_LIMIT");
    const created = stamp(), id = randomUUID();
    db.prepare("INSERT INTO invoice_channel_events(id,organization_id,channel_id,event_key,payload_hash,source_ciphertext,status,next_attempt_at,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,'queued',?,?,?,?)")
      .run(id, channel.organization_id, channel.id, eventKey, payloadHash, encrypt(serialized), created, created, created, new Date(Date.now() + documentRetentionDays() * 86400000).toISOString());
    db.prepare("UPDATE invoice_channels SET verified_at=COALESCE(verified_at,?),last_received_at=? WHERE id=? AND revoked_at IS NULL").run(created, created, channel.id);
    return { duplicate: false, event: eventProjection(row<Event>("SELECT * FROM invoice_channel_events WHERE id=?", id)!) };
  });
}
const telegramFile = z.object({ file_id: z.string().min(1).max(256), file_size: z.number().int().positive().max(DOCUMENT_LIMITS.fileBytes).optional(), file_name: z.string().max(256).optional(), mime_type: z.string().max(100).optional() });
export function receiveTelegram(id: string, secret: string | undefined, body: unknown) {
  const channel = authenticateProvider(id, "telegram", secret), config = configOf(channel);
  const update = z.object({ update_id: z.number().int().nonnegative().safe(), message: z.object({ message_id: z.number().int().nonnegative().safe(), date: z.number().int().nonnegative(), chat: z.object({ id: z.number().int().safe() }), from: z.object({ id: z.number().int().safe(), is_bot: z.boolean().optional() }), sender_chat: z.unknown().optional(), document: telegramFile.optional(), photo: z.array(telegramFile).max(20).optional() }).optional() }).parse(body);
  const message = update.message;
  if (!message) return { ignored: true, duplicate: false, event: null };
  if (String(message.chat.id) !== config.chatId || String(message.from.id) !== config.senderId || message.from.is_bot || message.sender_chat) throw new ApiError(403, "This chat and sender are not authorized for this company inbox", "CHANNEL_SENDER_REJECTED");
  const file = message.document ?? message.photo?.at(-1);
  if (!file) return { ignored: true, duplicate: false, event: null };
  return enqueue(channel, String(update.update_id), { filename: documentFilename(file.file_name ?? `telegram-${message.message_id}.jpg`), mediaType: file.mime_type ?? (message.photo ? "image/jpeg" : "application/octet-stream"), mediaId: file.file_id, senderId: String(message.from.id), chatId: String(message.chat.id), messageId: String(message.message_id), providerTimestamp: String(message.date), ...(file.file_size ? { declaredBytes: file.file_size } : {}) });
}
export function receiveWhatsApp(id: string, signature: string | undefined, raw: Buffer) {
  const channel = authenticateProvider(id, "whatsapp"), config = configOf(channel), secrets = secretsOf(channel);
  const expected = `sha256=${createHmac("sha256", secrets.appSecret!).update(raw).digest("hex")}`;
  if (!signature || !safeEqual(signature, expected)) throw new ApiError(401, "Meta webhook signature verification failed", "CHANNEL_SIGNATURE_INVALID");
  const media = z.object({ id: numericId, mime_type: z.enum(["application/pdf", "image/png", "image/jpeg"]), filename: z.string().max(256).optional(), sha256: z.string().max(100).optional() });
  const payload = z.object({ object: z.literal("whatsapp_business_account"), entry: z.array(z.object({
    id: numericId, changes: z.array(z.object({ field: z.string().max(100), value: z.object({
      metadata: z.object({ phone_number_id: numericId }).optional(),
      messages: z.array(z.object({ id: z.string().min(1).max(256), from: numericId, timestamp: numericId, type: z.string().max(100), document: media.optional(), image: media.optional() })).max(10).optional(),
    }) })).min(1).max(10),
  })).min(1).max(10) }).parse(JSON.parse(raw.toString("utf8")));
  const inputs: Array<{ key: string; source: Source }> = [];
  for (const entry of payload.entry) for (const change of entry.changes) {
    if (entry.id !== config.businessAccountId) throw new ApiError(403, "This Meta account is not bound to this company", "CHANNEL_ACCOUNT_REJECTED");
    if (change.field !== "messages" || !change.value.messages?.length) continue;
    if (change.value.metadata?.phone_number_id !== config.phoneNumberId) throw new ApiError(403, "This Meta phone number is not bound to this company", "CHANNEL_ACCOUNT_REJECTED");
    for (const message of change.value.messages) {
      if (message.type !== "document" && message.type !== "image") continue;
      if (message.from !== config.senderId) throw new ApiError(403, "This WhatsApp sender is not authorized for this company inbox", "CHANNEL_SENDER_REJECTED");
      const file = message[message.type]; if (!file) throw new ApiError(422, "Send a supported invoice document or image", "CHANNEL_FILE_REQUIRED");
      inputs.push({ key: message.id, source: { filename: documentFilename(file.filename ?? `whatsapp-${file.id}.${file.mime_type === "image/png" ? "png" : file.mime_type === "application/pdf" ? "pdf" : "jpg"}`), mediaType: file.mime_type, mediaId: file.id, messageId: message.id, senderId: message.from, providerTimestamp: message.timestamp, ...(file.sha256 ? { contentHash: file.sha256 } : {}) } });
    }
  }
  if (inputs.length > 10) throw new ApiError(413, "Send no more than ten invoice events per delivery", "CHANNEL_EVENT_LIMIT");
  return transaction(() => ({ events: inputs.map(input => enqueue(channel, input.key, input.source)) }));
}

async function providerFile(channel: Channel, source: Source, transport: ProviderTransport) {
  const secrets = secretsOf(channel), config = configOf(channel);
  const json = async (url: URL, headers: Record<string, string>) => { try { return JSON.parse((await transport(safeProviderUrl(url), headers, 32 * 1024)).toString("utf8")) as unknown; } catch (error) { if (error instanceof SyntaxError) throw new ApiError(503, "The provider returned invalid file metadata", "CHANNEL_PROVIDER_UNAVAILABLE"); throw error; } };
  if (channel.provider === "telegram") {
    if (!secrets.botToken) throw new ApiError(503, "Configure the Telegram token", "CHANNEL_SETUP_REQUIRED");
    const url = new URL(`https://api.telegram.org/bot${secrets.botToken}/getFile`); url.searchParams.set("file_id", source.mediaId!);
    const metadata = z.object({ ok: z.literal(true), result: z.object({ file_id: z.string(), file_path: z.string().min(1).max(512), file_size: z.number().int().positive().max(DOCUMENT_LIMITS.fileBytes).optional() }) }).parse(await json(url, {}));
    const path = metadata.result.file_path;
    if (metadata.result.file_id !== source.mediaId || !/^[A-Za-z0-9_./-]+$/.test(path) || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..")) throw new ApiError(422, "The provider returned an unsafe file path", "CHANNEL_URL_REJECTED");
    return transport(safeProviderUrl(`https://api.telegram.org/file/bot${secrets.botToken}/${path}`), {}, DOCUMENT_LIMITS.fileBytes);
  }
  if (!secrets.accessToken) throw new ApiError(503, "Configure the Meta access token", "CHANNEL_SETUP_REQUIRED");
  const headers = { Authorization: `Bearer ${secrets.accessToken}` }, url = new URL(`https://graph.facebook.com/${config.graphVersion}/${source.mediaId}`);
  url.searchParams.set("phone_number_id", config.phoneNumberId!);
  const metadata = z.object({ id: z.string(), url: z.string().max(4096), mime_type: z.string(), file_size: z.number().int().positive().max(DOCUMENT_LIMITS.fileBytes), sha256: z.string().optional() }).parse(await json(url, headers));
  if (metadata.id !== source.mediaId || metadata.mime_type !== source.mediaType) throw new ApiError(422, "Meta media metadata did not match the received invoice", "CHANNEL_MEDIA_MISMATCH");
  const mediaUrl = safeProviderUrl(metadata.url);
  if (mediaUrl.hostname !== "lookaside.fbsbx.com") throw new ApiError(422, "Meta returned an unsupported media host", "CHANNEL_URL_REJECTED");
  const bytes = await transport(mediaUrl, headers, DOCUMENT_LIMITS.fileBytes);
  const hash = digest(bytes);
  if (bytes.length !== metadata.file_size || metadata.sha256 && ![hash, Buffer.from(hash, "hex").toString("base64")].includes(metadata.sha256) || source.contentHash && ![hash, Buffer.from(hash, "hex").toString("base64")].includes(source.contentHash)) throw new ApiError(422, "The downloaded media did not match the provider evidence", "CHANNEL_MEDIA_MISMATCH");
  return bytes;
}
function claimEvent(event: Event) {
  const token = randomUUID();
  const changed = getDb().prepare("UPDATE invoice_channel_events SET status='processing',attempts=attempts+1,processing_token=?,updated_at=? WHERE id=? AND status IN ('queued','failed') AND expires_at>? AND attempts<6").run(token, stamp(), event.id, stamp());
  return changed.changes ? token : null;
}
async function saveEvent(channel: Channel, event: Event, token: string, bytes: Buffer) {
  const current = find(channel.id), access = channelAccess(current);
  const source = JSON.parse(decrypt(event.source_ciphertext!)) as Source;
  validateDocument(bytes, source.mediaType);
  if (source.contentHash && channel.provider === "folder" && source.contentHash !== digest(bytes)) throw new ApiError(422, "The file changed during upload. Rescan the folder", "CHANNEL_MEDIA_MISMATCH");
  if (!row("SELECT id FROM invoice_channel_events WHERE id=? AND processing_token=? AND expires_at>?", event.id, token, stamp())) throw new ApiError(409, "This intake event changed during processing", "CHANNEL_EVENT_CHANGED");
  const result = await uploadDocument(access, { filename: source.filename, mediaType: source.mediaType, bytes });
  find(channel.id); channelAccess(current);
  getDb().prepare("UPDATE invoice_documents SET expires_at=MIN(expires_at,?) WHERE id=? AND organization_id=?").run(event.expires_at, result.document.id, access.organizationId);
  getDb().prepare("UPDATE invoice_channel_events SET status='received',document_id=?,processing_token=NULL,error_code=NULL,updated_at=? WHERE id=? AND processing_token=?").run(result.document.id, stamp(), event.id, token);
  audit(access.userId, access.organizationId, "invoice_channel.received", event.id, { channelId: channel.id, provider: channel.provider, documentId: result.document.id });
  return { ...result, event: eventProjection(row<Event>("SELECT * FROM invoice_channel_events WHERE id=?", event.id)!) };
}
function failed(event: Event, token: string, error: unknown) {
  const code = error instanceof ApiError ? error.code : "CHANNEL_INGESTION_FAILED";
  getDb().prepare("UPDATE invoice_channel_events SET status='failed',processing_token=NULL,error_code=?,next_attempt_at=?,updated_at=? WHERE id=? AND processing_token=?")
    .run(code, new Date(Date.now() + Math.min(3600000, 15000 * 2 ** event.attempts)).toISOString(), stamp(), event.id, token);
}
export async function receiveFolder(id: string, bearer: string | undefined, eventKey: string, input: { filename: string; mediaType: string; bytes: Buffer }) {
  const { channel } = authenticateFolder(id, bearer);
  if (!/^[a-f0-9]{64}$/.test(eventKey) || digest(input.bytes) !== eventKey) throw new ApiError(422, "Use the file SHA-256 as the folder event ID", "CHANNEL_EVENT_INVALID");
  validateDocument(input.bytes, input.mediaType);
  const result = enqueue(channel, eventKey, { filename: documentFilename(input.filename), mediaType: input.mediaType, contentHash: eventKey });
  const event = row<Event>("SELECT * FROM invoice_channel_events WHERE id=?", result.event.id)!;
  if (["received", "expired", "revoked", "processing"].includes(event.status)) return { event: eventProjection(event), duplicate: true };
  const token = claimEvent(event); if (!token) throw new ApiError(409, "This event reached its retry limit. Inspect its saved status", "CHANNEL_RETRY_LIMIT");
  try { return await saveEvent(channel, event, token, input.bytes); } catch (error) { failed(event, token, error); throw error; }
}
export function folderEventStatus(id: string, bearer: string | undefined, eventKey: string) {
  authenticateFolder(id, bearer);
  if (!/^[a-f0-9]{64}$/.test(eventKey)) throw new ApiError(422, "Use a SHA-256 event ID", "CHANNEL_EVENT_INVALID");
  const event = row<Event>("SELECT * FROM invoice_channel_events WHERE channel_id=? AND event_key=?", id, eventKey);
  if (!event) throw new ApiError(404, "Folder event not found", "CHANNEL_EVENT_NOT_FOUND");
  return { event: eventProjection(event) };
}
export async function processPendingInvoiceEvents(options: { organizationId?: string; transport?: ProviderTransport; maxEvents?: number } = {}) {
  if (working) return { processed: 0, busy: true };
  working = true; let processed = 0;
  try {
    purgeInvoiceChannelRetention();
    getDb().prepare("UPDATE invoice_channel_events SET status='failed',processing_token=NULL,error_code='CHANNEL_INTERRUPTED',next_attempt_at=?,updated_at=? WHERE status='processing' AND updated_at<?").run(stamp(), stamp(), new Date(Date.now() - 5 * 60000).toISOString());
    const events = rows<Event>("SELECT e.* FROM invoice_channel_events e JOIN invoice_channels c ON c.id=e.channel_id WHERE c.provider<>'folder' AND c.revoked_at IS NULL AND e.status IN ('queued','failed') AND e.attempts<6 AND e.next_attempt_at<=? AND e.expires_at>? AND (? IS NULL OR e.organization_id=?) ORDER BY e.created_at LIMIT ?", stamp(), stamp(), options.organizationId ?? null, options.organizationId ?? null, Math.max(1, Math.min(5, options.maxEvents ?? 1)));
    for (const event of events) {
      const token = claimEvent(event); if (!token) continue;
      try { const channel = find(event.channel_id); channelAccess(channel); const source = JSON.parse(decrypt(event.source_ciphertext!)) as Source; await withInvoiceIngress(async () => saveEvent(channel, event, token, await providerFile(channel, source, options.transport ?? providerTransport))); }
      catch (error) { failed(event, token, error); }
      processed++;
    }
    return { processed, busy: false };
  } finally { working = false; }
}
export function retryInvoiceEvent(access: AccessContext, id: string) {
  manager(access);
  const event = row<Event>("SELECT * FROM invoice_channel_events WHERE id=? AND organization_id=?", id, access.organizationId);
  if (!event || !event.source_ciphertext || event.expires_at <= stamp()) throw new ApiError(404, "The retained intake event is unavailable", "CHANNEL_EVENT_NOT_FOUND");
  find(event.channel_id);
  if (event.status !== "failed") throw new ApiError(409, "Only failed intake events can be retried", "CHANNEL_EVENT_CHANGED");
  getDb().prepare("UPDATE invoice_channel_events SET attempts=0,status='queued',next_attempt_at=?,updated_at=? WHERE id=? AND status='failed'").run(stamp(), stamp(), id);
  audit(access.userId, access.organizationId, "invoice_channel.retry_requested", id);
  return { retry: true };
}
export function purgeInvoiceChannelRetention(at = stamp()) {
  transaction(db => {
    db.prepare("UPDATE invoice_channel_events SET source_ciphertext=NULL,status=CASE WHEN status IN ('queued','processing','failed') THEN 'expired' ELSE status END,processing_token=NULL WHERE expires_at<=?").run(at);
    db.prepare("UPDATE invoice_channel_events SET source_ciphertext=NULL WHERE document_id IS NULL AND status='received'").run();
    db.prepare("DELETE FROM invoice_channel_events WHERE created_at<?").run(new Date(Date.parse(at) - 90 * 86400000).toISOString());
  });
}
