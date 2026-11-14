import { createHmac, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { z } from "zod";
import { ApiError, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt, newToken } from "../identity/crypto";
import { getAccess, audit } from "../identity/session";
import { requireIntegrationOwner } from "./service";

const now = () => new Date().toISOString();
const eventTypes = ["integration.draft.created", "payment.status.changed", "funding.status.changed", "invoice.status.changed", "payroll.status.changed"] as const;
type EventType = typeof eventTypes[number];
const eventData = z.strictObject({ resourceId: z.string().min(1).max(128), kind: z.enum(["payment", "invoice", "recipient", "funding", "payroll"]).default("payment"), status: z.string().min(1).max(50), deliveredAmount: z.string().regex(/^\d{1,39}$/).optional(), creditedAmount: z.string().regex(/^\d{1,39}$/).optional(), sourceUpdatedAt: z.iso.datetime().optional() });
interface Endpoint { id: string; organization_id: string; created_by: string; url: string; secret_ciphertext: string; enabled: number; created_at: string; updated_at: string }
interface Delivery { id: string; endpoint_id: string; event_id: string; attempts: number; cycle_attempts: number; replay_count: number; lease_owner: string }
export type WebhookResolver = (hostname: string) => Promise<{ address: string; family: number }[]>;
export interface WebhookSend { url: URL; address: string; family: number; body: string; headers: Record<string, string> }
export type WebhookTransport = (input: WebhookSend) => Promise<number>;

const blockedV4 = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blockedV4.addSubnet(network, prefix);
const globalV6 = new BlockList(), blockedV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) blockedV6.addSubnet(network, prefix, "ipv6");

export function publicWebhookAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? !blockedV4.check(address) : family === 6 && globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
}

const resolveAddresses: WebhookResolver = hostname => lookup(hostname, { all: true, verbatim: true });
export async function validateWebhookDestination(value: string, resolver: WebhookResolver = resolveAddresses) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(422, "Enter an HTTPS webhook URL", "INVALID_WEBHOOK_DESTINATION"); }
  if (value.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.port && url.port !== "443" || !url.hostname.includes(".") || url.hostname.endsWith(".") || isIP(url.hostname.replace(/^\[|\]$/g, ""))) throw new ApiError(422, "Use a public HTTPS hostname on port 443 without credentials, query or fragment", "INVALID_WEBHOOK_DESTINATION");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let addresses: Awaited<ReturnType<WebhookResolver>>;
  try {
    addresses = await Promise.race([resolver(url.hostname), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("DNS_TIMEOUT")), 2000); })]);
  } catch { throw new ApiError(422, "The webhook hostname must resolve to public network addresses", "INVALID_WEBHOOK_DESTINATION"); }
  finally { if (timer) clearTimeout(timer); }
  if (!addresses.length || addresses.length > 16 || addresses.some(item => !publicWebhookAddress(item.address) || isIP(item.address) !== item.family)) throw new ApiError(422, "The webhook hostname must resolve only to public network addresses", "INVALID_WEBHOOK_DESTINATION");
  return { url, address: addresses[0].address, family: addresses[0].family };
}

export const sendWebhook: WebhookTransport = input => new Promise((resolve, reject) => {
  const outgoing = request(input.url, { method: "POST", agent: false, family: input.family, headers: input.headers, servername: input.url.hostname,
    lookup: (_hostname, _options, callback) => callback(null, input.address, input.family),
  }, response => {
    let size = 0;
    response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 65536) outgoing.destroy(new Error("RESPONSE_TOO_LARGE")); });
    response.on("end", () => resolve(response.statusCode ?? 0));
    response.on("error", () => reject(new Error("TRANSPORT_FAILED")));
  });
  const timeout = setTimeout(() => outgoing.destroy(new Error("TIMEOUT")), 5000);
  outgoing.on("close", () => clearTimeout(timeout));
  outgoing.on("error", () => reject(new Error("TRANSPORT_FAILED")));
  outgoing.end(input.body);
});

function safeEndpoint({ secret_ciphertext: _secret, ...endpoint }: Endpoint) { return endpoint; }
function endpointFor(access: AccessContext, id: string) {
  const endpoint = row<Endpoint>("SELECT * FROM integration_webhook_endpoints WHERE id=? AND organization_id=?", id, access.organizationId);
  if (!endpoint) throw new ApiError(404, "Webhook endpoint not found", "NOT_FOUND");
  return endpoint;
}
function endpointAuthorized(endpoint: Endpoint) {
  try {
    const access = getAccess(endpoint.created_by, endpoint.organization_id);
    return access.permissions.includes("company:manage") && access.permissions.includes("payments:read") && !!row("SELECT id FROM organizations WHERE id=? AND owner_id=?", endpoint.organization_id, endpoint.created_by);
  } catch { return false; }
}

export function webhookSettings(access: AccessContext, input: unknown = {}) {
  requireIntegrationOwner(access);
  const query = z.strictObject({ page: z.coerce.number().int().min(1).max(100000).default(1) }).parse(input);
  const total = row<{ total: number }>("SELECT COUNT(*) AS total FROM integration_webhook_deliveries d JOIN integration_webhook_endpoints e ON e.id=d.endpoint_id WHERE e.organization_id=?", access.organizationId)!.total;
  return { endpoints: rows<Endpoint>("SELECT * FROM integration_webhook_endpoints WHERE organization_id=? ORDER BY created_at DESC,id DESC", access.organizationId).map(safeEndpoint),
    deliveries: rows("SELECT d.id,d.endpoint_id AS endpointId,d.event_id AS eventId,d.state,d.attempts,d.replay_count AS replayCount,d.next_attempt_at AS nextAttemptAt,d.last_status AS lastStatus,d.last_error AS lastError,d.created_at AS createdAt,d.updated_at AS updatedAt,v.sequence,v.event_type AS eventType FROM integration_webhook_deliveries d JOIN integration_webhook_endpoints e ON e.id=d.endpoint_id JOIN integration_events v ON v.id=d.event_id WHERE e.organization_id=? ORDER BY v.sequence DESC,d.id DESC LIMIT 25 OFFSET ?", access.organizationId, (query.page - 1) * 25),
    page: query.page, total, hasMore: query.page * 25 < total, eventTypes };
}

export async function createWebhookEndpoint(access: AccessContext, input: unknown, resolver?: WebhookResolver) {
  requireIntegrationOwner(access);
  const parsed = z.strictObject({ url: z.string().min(1).max(2048) }).parse(input);
  const destination = await validateWebhookDestination(parsed.url, resolver);
  requireIntegrationOwner(access);
  const secret = `whsec_${newToken()}`, id = randomUUID();
  return transaction(db => {
    const count = row<{ total: number }>("SELECT COUNT(*) AS total FROM integration_webhook_endpoints WHERE organization_id=?", access.organizationId)!.total;
    if (count >= 10) throw new ApiError(409, "Use at most ten webhook endpoints per company", "ENDPOINT_LIMIT");
    db.prepare("INSERT INTO integration_webhook_endpoints(id,organization_id,created_by,url,secret_ciphertext,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id, access.organizationId, access.userId, destination.url.toString(), encrypt(secret), now(), now());
    audit(access.userId, access.organizationId, "integration.webhook.created", id);
    return { endpoint: safeEndpoint(endpointFor(access, id)), secret };
  });
}

export function setWebhookEnabled(access: AccessContext, id: string, enabled: boolean) {
  requireIntegrationOwner(access); endpointFor(access, id);
  return transaction(db => {
    db.prepare("UPDATE integration_webhook_endpoints SET enabled=?,updated_at=? WHERE id=? AND organization_id=?").run(Number(enabled), now(), id, access.organizationId);
    if (!enabled) db.prepare("UPDATE integration_webhook_deliveries SET state='cancelled',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE endpoint_id=? AND state IN ('queued','sending')").run(now(), id);
    audit(access.userId, access.organizationId, enabled ? "integration.webhook.enabled" : "integration.webhook.disabled", id);
    return { endpoint: safeEndpoint(endpointFor(access, id)) };
  });
}

export function rotateWebhookSecret(access: AccessContext, id: string) {
  requireIntegrationOwner(access); endpointFor(access, id);
  const secret = `whsec_${newToken()}`;
  getDb().prepare("UPDATE integration_webhook_endpoints SET secret_ciphertext=?,updated_at=? WHERE id=? AND organization_id=?").run(encrypt(secret), now(), id, access.organizationId);
  audit(access.userId, access.organizationId, "integration.webhook.rotated", id);
  return { secret };
}

export function inspectWebhookDelivery(access: AccessContext, id: string) {
  requireIntegrationOwner(access);
  const delivery = row<{ id: string; payload: string }>("SELECT d.*,v.payload FROM integration_webhook_deliveries d JOIN integration_webhook_endpoints e ON e.id=d.endpoint_id JOIN integration_events v ON v.id=d.event_id WHERE d.id=? AND e.organization_id=?", id, access.organizationId);
  if (!delivery) throw new ApiError(404, "Webhook delivery not found", "NOT_FOUND");
  return { ...delivery, payload: JSON.parse(delivery.payload), attempts: rows("SELECT id,attempt,started_at AS startedAt,completed_at AS completedAt,status,error FROM integration_webhook_attempts WHERE delivery_id=? ORDER BY started_at DESC,id DESC LIMIT 100", id) };
}

export function replayWebhookDelivery(access: AccessContext, id: string) {
  requireIntegrationOwner(access);
  return transaction(db => {
    const delivery = row<{ id: string; state: string; enabled: number }>("SELECT d.id,d.state,e.enabled FROM integration_webhook_deliveries d JOIN integration_webhook_endpoints e ON e.id=d.endpoint_id WHERE d.id=? AND e.organization_id=?", id, access.organizationId);
    if (!delivery) throw new ApiError(404, "Webhook delivery not found", "NOT_FOUND");
    if (!delivery.enabled || delivery.state === "sending" || delivery.state === "queued") throw new ApiError(409, "Enable the endpoint and wait for its active delivery before replaying", "DELIVERY_ACTIVE");
    db.prepare("UPDATE integration_webhook_deliveries SET state='queued',cycle_attempts=0,replay_count=replay_count+1,next_attempt_at=?,updated_at=? WHERE id=?").run(now(), now(), id);
    audit(access.userId, access.organizationId, "integration.webhook.replayed", id);
    return { queued: true };
  });
}

export function enqueueIntegrationEvent(organizationId: string, type: EventType, sourceKey: string, input: unknown, occurredAt = now()) {
  const data = eventData.parse(input);
  return transaction(db => {
    const existing = row<{ id: string }>("SELECT id FROM integration_events WHERE organization_id=? AND source_key=?", organizationId, sourceKey);
    if (existing) return existing.id;
    const id = randomUUID();
    db.prepare("INSERT INTO integration_events(id,organization_id,event_type,source_key,payload,created_at) VALUES(?,?,?,?,?,?)").run(id, organizationId, type, sourceKey, "{}", occurredAt);
    const sequence = row<{ sequence: number }>("SELECT sequence FROM integration_events WHERE id=?", id)!.sequence;
    const payload = JSON.stringify({ version: "2026-11-01", id, sequence, type, occurredAt, organizationId, data });
    db.prepare("UPDATE integration_events SET payload=? WHERE id=?").run(payload, id);
    const endpoints = rows<{ id: string }>("SELECT id FROM integration_webhook_endpoints WHERE organization_id=? AND enabled=1 AND created_at<=?", organizationId, occurredAt);
    for (const endpoint of endpoints) db.prepare("INSERT INTO integration_webhook_deliveries(id,endpoint_id,event_id,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(randomUUID(), endpoint.id, id, now(), now(), now());
    return id;
  });
}

export function publishIntegrationPaymentEvents(limit = 100, organizationId?: string) {
  return transaction(db => {
    const changes = rows<{ sequence: number; payment_id: string; organization_id: string; status: string; updated_at: string; delivered_amount: string }>("SELECT * FROM integration_payment_changes WHERE published_at IS NULL AND (? IS NULL OR organization_id=?) ORDER BY sequence LIMIT ?", organizationId ?? null, organizationId ?? null, Math.max(1, Math.min(limit, 500)));
    for (const change of changes) {
      enqueueIntegrationEvent(change.organization_id, "payment.status.changed", `payment-change:${change.sequence}`, { resourceId: change.payment_id, kind: "payment", status: change.status, deliveredAmount: change.delivered_amount, sourceUpdatedAt: change.updated_at }, change.updated_at);
      db.prepare("UPDATE integration_payment_changes SET published_at=? WHERE sequence=?").run(now(), change.sequence);
    }
    const states = rows<{ sequence: number; resource_id: string; organization_id: string; kind: "funding" | "invoice" | "payroll"; status: string; credited_amount: string | null; updated_at: string }>("SELECT * FROM integration_state_changes WHERE published_at IS NULL AND (? IS NULL OR organization_id=?) ORDER BY sequence LIMIT ?", organizationId ?? null, organizationId ?? null, Math.max(1, Math.min(limit, 500)));
    for (const change of states) {
      enqueueIntegrationEvent(change.organization_id, `${change.kind}.status.changed`, `state-change:${change.sequence}`, { resourceId: change.resource_id, kind: change.kind, status: change.status, ...(change.credited_amount === null ? {} : { creditedAmount: change.credited_amount }), sourceUpdatedAt: change.updated_at }, change.updated_at);
      db.prepare("UPDATE integration_state_changes SET published_at=? WHERE sequence=?").run(now(), change.sequence);
    }
    return changes.length + states.length;
  });
}

export function webhookSignature(secret: string, timestamp: string, body: string) {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export async function dispatchIntegrationWebhooks(options: { organizationId?: string; limit?: number; resolver?: WebhookResolver; transport?: WebhookTransport } = {}) {
  const published = publishIntegrationPaymentEvents(100, options.organizationId);
  let delivered = 0, attempted = 0;
  const limit = Math.max(0, Math.min(options.limit ?? 5, 10));
  for (let index = 0; index < limit; index++) {
    const delivery = transaction(db => {
      db.prepare("UPDATE integration_webhook_attempts SET completed_at=?,error='LEASE_EXPIRED' WHERE completed_at IS NULL AND delivery_id IN (SELECT d.id FROM integration_webhook_deliveries d JOIN integration_webhook_endpoints e ON e.id=d.endpoint_id WHERE d.state='sending' AND d.lease_until<=? AND (? IS NULL OR e.organization_id=?))").run(now(), now(), options.organizationId ?? null, options.organizationId ?? null);
      db.prepare("UPDATE integration_webhook_deliveries SET state='queued',lease_owner=NULL,lease_until=NULL WHERE state='sending' AND lease_until<=? AND (? IS NULL OR endpoint_id IN (SELECT id FROM integration_webhook_endpoints WHERE organization_id=?))").run(now(), options.organizationId ?? null, options.organizationId ?? null);
      const item = row<Delivery>("SELECT d.* FROM integration_webhook_deliveries d JOIN integration_webhook_endpoints e ON e.id=d.endpoint_id WHERE d.state='queued' AND d.next_attempt_at<=? AND (? IS NULL OR e.organization_id=?) ORDER BY d.created_at,d.id LIMIT 1", now(), options.organizationId ?? null, options.organizationId ?? null);
      if (!item) return null;
      item.lease_owner = randomUUID(); item.attempts++; item.cycle_attempts++;
      db.prepare("UPDATE integration_webhook_deliveries SET state='sending',attempts=attempts+1,cycle_attempts=cycle_attempts+1,lease_owner=?,lease_until=?,updated_at=? WHERE id=? AND state='queued'").run(item.lease_owner, new Date(Date.now() + 30000).toISOString(), now(), item.id);
      db.prepare("INSERT INTO integration_webhook_attempts(id,delivery_id,attempt,started_at) VALUES(?,?,?,?)").run(item.lease_owner, item.id, item.attempts, now());
      return item;
    });
    if (!delivery) break;
    const endpoint = row<Endpoint>("SELECT * FROM integration_webhook_endpoints WHERE id=?", delivery.endpoint_id)!;
    let status: number | null = null, failure: string | null = null, cancelled = false;
    try {
      if (!endpoint.enabled || !endpointAuthorized(endpoint)) { cancelled = true; throw new Error("ENDPOINT_DISABLED"); }
      const destination = await validateWebhookDestination(endpoint.url, options.resolver);
      const current = row<Endpoint>("SELECT * FROM integration_webhook_endpoints WHERE id=?", endpoint.id)!;
      if (!current.enabled || !endpointAuthorized(current) || current.updated_at !== endpoint.updated_at) { cancelled = true; throw new Error("ENDPOINT_CHANGED"); }
      const event = row<{ payload: string }>("SELECT payload FROM integration_events WHERE id=?", delivery.event_id)!;
      if (Buffer.byteLength(event.payload) > 16384) throw new Error("PAYLOAD_TOO_LARGE");
      const timestamp = Math.floor(Date.now() / 1000).toString();
      attempted++;
      status = await (options.transport ?? sendWebhook)({ ...destination, body: event.payload, headers: {
        "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(event.payload)),
        "User-Agent": "Razor-Webhooks/1", "Razor-Event-Id": delivery.event_id, "Razor-Delivery-Id": delivery.id,
        "Razor-Timestamp": timestamp, "Razor-Signature": webhookSignature(decrypt(current.secret_ciphertext), timestamp, event.payload),
      } });
      if (status < 200 || status >= 300) failure = status >= 300 && status < 400 ? "REDIRECT_REJECTED" : "HTTP_REJECTED";
    } catch (error) { failure = error instanceof ApiError ? error.code : cancelled ? "ENDPOINT_DISABLED" : "TRANSPORT_FAILED"; }
    const success = status !== null && status >= 200 && status < 300 && !failure;
    if (success) delivered++;
    transaction(db => {
      db.prepare("UPDATE integration_webhook_attempts SET completed_at=?,status=?,error=? WHERE id=?").run(now(), status, failure, delivery.lease_owner);
      const age = delivery.cycle_attempts;
      db.prepare("UPDATE integration_webhook_deliveries SET state=?,lease_owner=NULL,lease_until=NULL,last_status=?,last_error=?,next_attempt_at=?,updated_at=? WHERE id=? AND lease_owner=? AND state='sending'")
        .run(success ? "delivered" : cancelled ? "cancelled" : age >= 8 ? "failed" : "queued", status, failure,
          new Date(Date.now() + Math.min(3600000, 15000 * 2 ** Math.min(age, 8))).toISOString(), now(), delivery.id, delivery.lease_owner);
    });
  }
  return { published, attempted, delivered };
}
