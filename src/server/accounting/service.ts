import { randomUUID } from "node:crypto";
import { z } from "zod";
import { companyDate } from "../../lib/company-time";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt, hashToken, newToken } from "../identity/crypto";
import { audit, getAccess } from "../identity/session";
import { getBillTerms } from "../business/bill-terms";
import { canonical, digest, functionalAmount, mappingInput, postingPayload, type CatalogItem, type Connection, type Entity, type Job, type Mapping, type Provider } from "./model";
import { accountingTransport, apiBase, apiHeaders, basicAuthentication, catalogItems, collection, externalObject, parseTokens, providerConfig, providerEntities, type AccountingTransport, type Tokens, type TransportResponse } from "./providers";

const now = () => new Date().toISOString();
const safeId = z.string().min(1).max(128);
export function accountingAccess(access: AccessContext, approve = false) {
 const live = getAccess(access.userId, access.organizationId);
 for (const permission of ["company:read", "company:manage", "payments:read", "reports:read", ...(approve ? ["payments:approve"] : [])]) requirePermission(live, permission);
 return live;
}
function connectionFor(access: AccessContext, id: string) {
 const value = row<Connection>("SELECT * FROM accounting_connections WHERE id=? AND organization_id=?", id, access.organizationId);
 if (!value) throw new ApiError(404, "Accounting connection not found", "ACCOUNTING_NOT_FOUND");
 return value;
}
function safeConnection(value: Connection) {
 const { token_ciphertext: _token, refresh_owner: _owner, refresh_until: _until, entities_ciphertext, ...safe } = value;
 return { ...safe, entities: entities_ciphertext ? JSON.parse(decrypt(entities_ciphertext)) as Entity[] : [], configured: providerConfig(value.provider).configured };
}
function currentMapping(connection: Connection) {
 const found = row<{ version: number; payload_ciphertext: string }>("SELECT version,payload_ciphertext FROM accounting_mappings WHERE connection_id=? AND entity_id=? ORDER BY version DESC LIMIT 1", connection.id, connection.entity_id);
 return found ? { version: found.version, value: JSON.parse(decrypt(found.payload_ciphertext)) as Mapping } : null;
}
function jobFor(access: AccessContext, id: string) {
 const value = row<Job>("SELECT * FROM accounting_jobs WHERE id=? AND organization_id=?", id, access.organizationId);
 if (!value) throw new ApiError(404, "Accounting posting not found", "ACCOUNTING_NOT_FOUND"); return value;
}
export function accountingOverview(access: AccessContext, page = 1) {
 const live = accountingAccess(access), bounded = Math.max(1, Math.min(100000, page));
 const timezone = row<{timezone:string}>("SELECT timezone FROM organizations WHERE id=?",live.organizationId)!.timezone;
 return { providers: (["quickbooks", "xero"] as const).map(provider => ({ provider, configured: providerConfig(provider).configured, environment: providerConfig(provider).environment })),
  connections: rows<Connection>("SELECT * FROM accounting_connections WHERE organization_id=? ORDER BY provider", live.organizationId).map(value => ({ ...safeConnection(value), mapping: currentMapping(value) })),
  jobs: rows<Job>("SELECT * FROM accounting_jobs WHERE organization_id=? ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET ?", live.organizationId, (bounded - 1) * 25).map(({ payload_ciphertext, ...item }) => ({ ...item, posting: JSON.parse(decrypt(payload_ciphertext)) })),
  observations: rows<{ kind: string; external_id: string; revision: string; state: string; matching_job_id: string | null; observed_at: string }>("SELECT o.kind,o.external_id,o.revision,o.state,o.matching_job_id,o.observed_at FROM accounting_observations o JOIN accounting_connections c ON c.id=o.connection_id WHERE c.organization_id=? ORDER BY o.observed_at DESC LIMIT 25", live.organizationId),
  bills: rows<{ id: string; reference: string; amount: string; title: string; due_date:string|null; accepted_at: string | null; status: string }>("SELECT id,reference,amount,title,due_date,accepted_at,status FROM bills WHERE organization_id=? ORDER BY created_at DESC LIMIT 100", live.organizationId).map(value => ({ ...value, title: decrypt(value.title), dueDate:value.due_date?companyDate(value.due_date,timezone):null })),
  settlements: rows<{id:string;reference:string;amount:string}>("SELECT p.id,b.reference,p.amount FROM payments p JOIN bill_installments i ON i.payment_id=p.id JOIN bills b ON b.id=i.bill_id WHERE p.organization_id=? AND b.organization_id=? AND p.status='paid' AND p.delivered_amount=p.amount ORDER BY p.updated_at DESC LIMIT 100", live.organizationId, live.organizationId),
  page: bounded, hasMore: !!row("SELECT id FROM accounting_jobs WHERE organization_id=? ORDER BY created_at DESC,id DESC LIMIT 1 OFFSET ?", live.organizationId, bounded * 25),
  scope: "Reviewed bill drafts and verified full-principal settlement records only. No payroll rows, bank transfers, automatic bank matching, tax calculations, fee/FX journals, credit-note posting or NetSuite sync. External accounting state never creates Razor cash or delivery evidence." };
}
function requireInitiatingSession(userId: string, sessionId: string | null) {
 if (!sessionId || !row("SELECT id FROM sessions WHERE id=? AND user_id=? AND expires_at>?", sessionId, userId, now())) throw new ApiError(401, "Sign in again and start a new accounting connection", "ACCOUNTING_SESSION_EXPIRED");
}
export function beginAccountingConnection(access: AccessContext, provider: Provider, browserNonce: string, initiatingSessionId: string) {
 const live = accountingAccess(access), config = providerConfig(provider);
 if (!config.configured) throw new ApiError(503, "The operator must configure this provider's confidential web application first", "ACCOUNTING_SETUP_REQUIRED");
 if (!/^[A-Za-z0-9_-]{43}$/.test(browserNonce)) throw new ApiError(422, "Start a new connection from this browser", "ACCOUNTING_BROWSER_REQUIRED");
 requireInitiatingSession(live.userId, initiatingSessionId);
 const state = newToken();
 const id = transaction(db => {
  const previous = row<Connection>("SELECT * FROM accounting_connections WHERE organization_id=? AND provider=?", live.organizationId, provider), id = previous?.id ?? randomUUID();
  if (previous && previous.environment !== config.environment && previous.token_ciphertext) throw new ApiError(409, "Disconnect this grant before switching the provider environment", "ACCOUNTING_ENVIRONMENT_CHANGED");
  db.prepare("INSERT INTO accounting_connections(id,organization_id,provider,created_by,status,environment,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?,?) ON CONFLICT(organization_id,provider) DO UPDATE SET created_by=excluded.created_by,status='pending',environment=excluded.environment,version=version+1,last_error=NULL,updated_at=excluded.updated_at").run(id, live.organizationId, provider, live.userId, config.environment, now(), now());
  db.prepare("UPDATE accounting_oauth_states SET consumed_at=? WHERE connection_id=? AND consumed_at IS NULL").run(now(), id);
  db.prepare("INSERT INTO accounting_oauth_states(state_hash,connection_id,user_id,expires_at,browser_nonce_hash,initiating_session_id) VALUES(?,?,?,?,?,?)").run(hashToken(state), id, live.userId, new Date(Date.now() + 600000).toISOString(), hashToken(browserNonce), initiatingSessionId);
  audit(live.userId, live.organizationId, "accounting.connect_requested", id, { provider }); return id;
 });
 const url = new URL(config.authorize); url.search = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: config.redirectUri, scope: config.scopes, state }).toString();
 return { connectionId: id, authorizationUrl: url.toString(), redirectUri: config.redirectUri, expiresInSeconds: 600, appType: "confidential_web_authorization_code" };
}
export async function finishAccountingConnection(provider: Provider, input: { state: string; code?: string; realmId?: string; error?: string }, browserNonce: string | undefined, transport: AccountingTransport = accountingTransport) {
 if (!input.state || input.state.length > 200) throw new ApiError(422, "The connection state is invalid or expired", "ACCOUNTING_STATE_INVALID");
 if (!browserNonce || !/^[A-Za-z0-9_-]{43}$/.test(browserNonce)) throw new ApiError(409, "Return to the browser where this connection was requested and start again", "ACCOUNTING_BROWSER_REQUIRED");
 const held = transaction(db => {
  const state = row<{ connection_id: string; user_id: string; initiating_session_id: string | null }>("SELECT * FROM accounting_oauth_states WHERE state_hash=? AND browser_nonce_hash=? AND expires_at>? AND consumed_at IS NULL", hashToken(input.state), hashToken(browserNonce), now());
  if (!state) throw new ApiError(409, "This connection response expired or was already used", "ACCOUNTING_STATE_INVALID");
  const connection = row<Connection>("SELECT * FROM accounting_connections WHERE id=? AND provider=?", state.connection_id, provider);
  if (!connection || connection.status !== "pending" || connection.created_by !== state.user_id) throw new ApiError(409, "This connection request changed", "ACCOUNTING_STATE_INVALID");
  requireInitiatingSession(state.user_id, state.initiating_session_id);
  accountingAccess({ userId: state.user_id, organizationId: connection.organization_id, permissions: [] });
  db.prepare("UPDATE accounting_oauth_states SET consumed_at=? WHERE state_hash=? AND consumed_at IS NULL").run(now(), hashToken(input.state)); return { ...connection, initiatingSessionId: state.initiating_session_id };
 });
 if (input.error || !input.code || input.code.length > 4096) {
  getDb().prepare("UPDATE accounting_connections SET status='reauthorize',last_error='CONSENT_NOT_COMPLETED',updated_at=? WHERE id=? AND version=?").run(now(), held.id, held.version);
  return { organizationId: held.organization_id, connected: false };
 }
 try {
  const config = providerConfig(provider), response = await transport({ url: config.token, method: "POST", headers: { authorization: basicAuthentication(provider), "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: config.redirectUri }).toString() });
  if (response.status !== 200) throw new Error("TOKEN_EXCHANGE_FAILED");
  const parsed = parseTokens(response.body), entities = await providerEntities(provider, parsed.tokens.accessToken, input.realmId, transport);
  if (!entities.length) throw new Error("NO_COMPANY_CONNECTION");
  transaction(db => {
   requireInitiatingSession(held.created_by, held.initiatingSessionId);
   accountingAccess({ userId: held.created_by, organizationId: held.organization_id, permissions: [] });
   const changed = db.prepare("UPDATE accounting_connections SET token_ciphertext=?,access_expires_at=?,entities_ciphertext=?,status='select_entity',entity_id=NULL,entity_name=NULL,currency=NULL,last_error=NULL,updated_at=? WHERE id=? AND version=? AND status='pending'")
    .run(encrypt(JSON.stringify(parsed.tokens)), parsed.expiresAt, encrypt(JSON.stringify(entities)), now(), held.id, held.version);
   if (!changed.changes) throw new ApiError(409, "The company connection changed during authorization", "ACCOUNTING_STATE_INVALID");
   audit(held.created_by, held.organization_id, "accounting.consent_received", held.id, { provider, entities: entities.length });
  });
  return { organizationId: held.organization_id, connected: false, selectionRequired: true };
 } catch {
  getDb().prepare("UPDATE accounting_connections SET status='reauthorize',last_error='AUTHORIZATION_FAILED',updated_at=? WHERE id=? AND version=? AND status='pending'").run(now(), held.id, held.version);
  throw new ApiError(502, "The accounting grant could not be verified. Start a new connection request", "ACCOUNTING_AUTH_FAILED");
 }
}

async function accessToken(connection: Connection, transport: AccountingTransport) {
 const current = row<Connection>("SELECT * FROM accounting_connections WHERE id=? AND organization_id=?", connection.id, connection.organization_id);
 if (!current || current.version !== connection.version || current.status !== connection.status) throw new ApiError(409, "Refresh the changed connection", "ACCOUNTING_CONNECTION_CHANGED");
 connection = current;
 if (!connection.token_ciphertext || !["active", "select_entity"].includes(connection.status)) throw new ApiError(409, "Connect and select this accounting company first", "ACCOUNTING_CONNECTION_REQUIRED");
 accountingAccess({ userId: connection.created_by, organizationId: connection.organization_id, permissions: [] });
 const tokens = JSON.parse(decrypt(connection.token_ciphertext)) as Tokens;
 if (connection.access_expires_at && connection.access_expires_at > new Date(Date.now() + 60000).toISOString()) return tokens.accessToken;
 const lease = randomUUID();
 transaction(db => {
  const current = row<Connection>("SELECT * FROM accounting_connections WHERE id=?", connection.id)!;
  if (current.version !== connection.version || current.status !== connection.status) throw new ApiError(409, "Refresh the changed connection", "ACCOUNTING_CONNECTION_CHANGED");
  if (current.refresh_until && current.refresh_until > now()) throw new ApiError(409, "The accounting grant is refreshing. Retry shortly", "ACCOUNTING_REFRESH_BUSY");
  db.prepare("UPDATE accounting_connections SET refresh_owner=?,refresh_until=? WHERE id=?").run(lease, new Date(Date.now() + 30000).toISOString(), connection.id);
 });
 try {
  const response = await transport({ url: providerConfig(connection.provider).token, method: "POST", headers: { authorization: basicAuthentication(connection.provider), "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refreshToken }).toString() });
  if (response.status !== 200) throw new Error("TOKEN_REFRESH_FAILED");
  const next = parseTokens(response.body);
  transaction(db => {
   accountingAccess({ userId: connection.created_by, organizationId: connection.organization_id, permissions: [] });
   const changed = db.prepare("UPDATE accounting_connections SET token_ciphertext=?,access_expires_at=?,refresh_owner=NULL,refresh_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND version=? AND refresh_owner=? AND status=?")
    .run(encrypt(JSON.stringify(next.tokens)), next.expiresAt, now(), connection.id, connection.version, lease, connection.status);
   if (!changed.changes) throw new Error("CONNECTION_CHANGED");
  }); return next.tokens.accessToken;
 } catch {
  getDb().prepare("UPDATE accounting_connections SET status='reauthorize',refresh_owner=NULL,refresh_until=NULL,last_error='REFRESH_NOT_CONFIRMED',updated_at=? WHERE id=? AND refresh_owner=?").run(now(), connection.id, lease);
  throw new ApiError(409, "The provider grant needs a fresh authorization. No financial request was replayed", "ACCOUNTING_REAUTHORIZE_REQUIRED");
 }
}
async function providerRead(connection: Connection, path: string, transport: AccountingTransport) {
 const token = await accessToken(connection, transport);
 return transport({ url: `${apiBase(connection)}${path}`, method: "GET", headers: apiHeaders(connection, token) });
}
export async function selectAccountingEntity(access: AccessContext, id: string, entityId: string, transport: AccountingTransport = accountingTransport) {
 const live = accountingAccess(access), connection = connectionFor(live, id), token = await accessToken(connection, transport);
 safeId.parse(entityId);
 const entities = await providerEntities(connection.provider, token, connection.provider === "quickbooks" ? entityId : undefined, transport);
 const entity = entities.find(value => value.id === entityId);
 if (!entity || !(JSON.parse(decrypt(connection.entities_ciphertext!)) as Entity[]).some(value => value.id === entityId)) throw new ApiError(403, "Select a company verified by this grant", "ACCOUNTING_ENTITY_INVALID");
 const scoped = { ...connection, entity_id: entity.id };
 const response = await transport({ url: `${apiBase(scoped)}${connection.provider === "quickbooks" ? "/preferences" : "/Organisation"}`, method: "GET", headers: apiHeaders(scoped, token) });
 const body = response.body as { Preferences?: { CurrencyPrefs?: { HomeCurrency?: { value?: string } } }; Organisations?: { OrganisationID?: string; Name?: string; BaseCurrency?: string }[] };
 const currency = connection.provider === "quickbooks" ? body.Preferences?.CurrencyPrefs?.HomeCurrency?.value : body.Organisations?.[0]?.BaseCurrency;
 if (connection.provider === "xero" && body.Organisations?.[0]?.OrganisationID !== entity.id) throw new ApiError(403, "The selected Xero organisation identity did not match", "ACCOUNTING_ENTITY_INVALID");
 if (response.status !== 200 || !currency || !["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "INR", "SGD"].includes(currency)) throw new ApiError(409, "This connector supports only verified two-decimal functional currencies. No currency was inferred", "ACCOUNTING_CURRENCY_UNSUPPORTED");
 return transaction(db => {
  accountingAccess(live);
  const changed = db.prepare("UPDATE accounting_connections SET status='active',entity_id=?,entity_name=?,currency=?,version=version+1,last_error=NULL,updated_at=? WHERE id=? AND version=? AND status IN ('active','select_entity')")
   .run(entity.id, entity.name, currency, now(), id, connection.version);
  if (!changed.changes) throw new ApiError(409, "This company grant changed. Refresh before selection", "ACCOUNTING_CONNECTION_CHANGED");
  audit(live.userId, live.organizationId, "accounting.entity_selected", id, { provider: connection.provider, entityId });
  return safeConnection(connectionFor(live, id));
 });
}
export async function disconnectAccounting(access: AccessContext, id: string, transport: AccountingTransport = accountingTransport) {
 const live = accountingAccess(access), connection = connectionFor(live, id), tokens = connection.token_ciphertext ? JSON.parse(decrypt(connection.token_ciphertext)) as Tokens : null;
 transaction(db => {
  db.prepare("UPDATE accounting_connections SET status='disabled',token_ciphertext=NULL,access_expires_at=NULL,refresh_owner=NULL,refresh_until=NULL,version=version+1,last_error=NULL,updated_at=? WHERE id=?").run(now(), id);
  db.prepare("UPDATE accounting_oauth_states SET consumed_at=? WHERE connection_id=? AND consumed_at IS NULL").run(now(), id);
  db.prepare("UPDATE accounting_jobs SET state='held',last_error='CONNECTION_DISABLED',updated_at=? WHERE connection_id=? AND state IN ('review','queued')").run(now(), id);
  audit(live.userId, live.organizationId, "accounting.disconnected", id);
 });
 let providerRevoked = false;
 if (tokens) try {
  let response: TransportResponse;
  if (connection.provider === "quickbooks") response = await transport({ url: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke", method: "POST", headers: { authorization: basicAuthentication(connection.provider), "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ token: tokens.refreshToken }) });
  else {
   const entity = connection.entities_ciphertext ? (JSON.parse(decrypt(connection.entities_ciphertext)) as Entity[]).find(value => value.id === connection.entity_id) : null;
   if (!entity?.connectionId) throw new Error("NO_CONNECTION");
   response = await transport({ url: `https://api.xero.com/connections/${encodeURIComponent(entity.connectionId)}`, method: "DELETE", headers: { authorization: `Bearer ${tokens.accessToken}`, accept: "application/json" } });
  }
  providerRevoked = response.status >= 200 && response.status < 300;
 } catch {}
 if (!providerRevoked && tokens) getDb().prepare("UPDATE accounting_connections SET last_error='PROVIDER_REVOCATION_UNCONFIRMED' WHERE id=? AND status='disabled'").run(id);
 return { stoppedLocally: true, providerRevoked, note: providerRevoked ? "Provider disconnection confirmed" : "Local access stopped and saved tokens removed. If provider revocation is unconfirmed, revoke the grant in your provider account." };
}

export async function refreshAccountingCatalog(access: AccessContext, id: string, page = 1, transport: AccountingTransport = accountingTransport) {
 const live = accountingAccess(access), connection = connectionFor(live, id);
 if (connection.status !== "active" || !connection.entity_id) throw new ApiError(409, "Select the accounting company before loading its catalogs", "ACCOUNTING_ENTITY_REQUIRED");
 if (!Number.isInteger(page) || page < 1 || page > 100) throw new ApiError(422, "Choose a catalog page from 1 to 100", "INVALID_PAGE");
 const counts: Record<string, number> = {};
 for (const kind of ["account", "tax", "contact"] as const) {
  if (connection.provider === "xero" && page > 1 && kind !== "contact") continue;
  const entity = kind === "account" ? "Account" : kind === "tax" ? "TaxCode" : "Vendor";
  const path = connection.provider === "quickbooks" ? `/query?query=${encodeURIComponent(`SELECT * FROM ${entity} STARTPOSITION ${(page - 1) * 100 + 1} MAXRESULTS 100`)}` : `/${kind === "account" ? "Accounts" : kind === "tax" ? "TaxRates" : `Contacts?page=${page}&pageSize=100`}`;
  const response = await providerRead(connection, path, transport);
  if (response.status !== 200) throw new ApiError(response.status === 429 ? 429 : 502, "The accounting catalog is unavailable. Existing mappings were retained", "ACCOUNTING_CATALOG_UNAVAILABLE");
  const items = catalogItems(connection.provider, kind, response.body); counts[kind] = items.length;
  transaction(db => {
   accountingAccess(live);
   const current = connectionFor(live, id);
   if (current.version !== connection.version || current.status !== "active") throw new ApiError(409, "The connection changed during catalog loading", "ACCOUNTING_CONNECTION_CHANGED");
   for (const item of items) db.prepare("INSERT INTO accounting_catalog(connection_id,entity_id,kind,external_id,data_ciphertext,observed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(connection_id,entity_id,kind,external_id) DO UPDATE SET data_ciphertext=excluded.data_ciphertext,observed_at=excluded.observed_at")
    .run(id, connection.entity_id, kind, item.id, encrypt(JSON.stringify(item)), now());
  });
 }
 return { page, counts, mayHaveMore: Object.values(counts).some(count => count >= 100), catalog: accountingCatalog(live, id) };
}
export function accountingCatalog(access: AccessContext, id: string) {
 const live = accountingAccess(access), connection = connectionFor(live, id);
 return { items: rows<{ data_ciphertext: string; observed_at: string }>("SELECT data_ciphertext,observed_at FROM accounting_catalog WHERE connection_id=? AND entity_id=? ORDER BY kind,external_id", id, connection.entity_id).map(value => ({ ...JSON.parse(decrypt(value.data_ciphertext)) as CatalogItem, observedAt: value.observed_at })),
  recipients: rows<{ id: string; name: string }>("SELECT id,name FROM recipients WHERE organization_id=? AND archived=0 ORDER BY id LIMIT 200", live.organizationId).map(value => ({ id: value.id, name: decrypt(value.name) })),
  mapping: currentMapping(connection), functionalCurrency: connection.currency };
}
function chosenItem(connection: Connection, kind: CatalogItem["kind"], id: string) {
 const saved = row<{ data_ciphertext: string; observed_at: string }>("SELECT data_ciphertext,observed_at FROM accounting_catalog WHERE connection_id=? AND entity_id=? AND kind=? AND external_id=?", connection.id, connection.entity_id, kind, id);
 if (!saved || saved.observed_at < new Date(Date.now() - 86400000).toISOString()) throw new ApiError(409, "Refresh the provider catalogs before selecting these mappings", "ACCOUNTING_CATALOG_STALE");
 const item = JSON.parse(decrypt(saved.data_ciphertext)) as CatalogItem;
 if (!item.active) throw new ApiError(409, "Choose an active accounting catalog item", "ACCOUNTING_MAPPING_INVALID");
 return item;
}
export function saveAccountingMapping(access: AccessContext, id: string, data: unknown) {
 const live = accountingAccess(access, true), input = mappingInput.parse(data), connection = connectionFor(live, id);
 if (connection.status !== "active" || !connection.entity_id || !connection.currency) throw new ApiError(409, "Select a verified company first", "ACCOUNTING_ENTITY_REQUIRED");
 return transaction(db => {
  if ((currentMapping(connection)?.version ?? 0) !== input.expectedVersion) throw new ApiError(409, "The account mapping changed. Review its latest version", "ACCOUNTING_MAPPING_CHANGED");
  const expense = chosenItem(connection, "account", input.expenseAccountId), bank = chosenItem(connection, "account", input.bankAccountId), tax = chosenItem(connection, "tax", input.taxCodeId);
  if (!["expense", "otherexpense", "costofgoodssold", "directcosts", "overheads"].includes(expense.type?.toLowerCase().replace(/[^a-z]/g, "") ?? "") || bank.type?.toLowerCase() !== "bank" || bank.currency && bank.currency !== connection.currency || !tax.zeroTax) throw new ApiError(422, "Choose an expense account, a functional-currency clearing bank account and an explicitly zero-tax code. Tax calculations are unsupported", "ACCOUNTING_MAPPING_INVALID");
  if (connection.provider === "xero" && !expense.code) throw new ApiError(422, "The Xero expense account needs its actual account code", "ACCOUNTING_MAPPING_INVALID");
  const seen = new Set<string>();
  for (const contact of input.contacts) {
   if (seen.has(contact.recipientId) || !row("SELECT id FROM recipients WHERE id=? AND organization_id=?", contact.recipientId, live.organizationId)) throw new ApiError(422, "Map each company payee once", "ACCOUNTING_MAPPING_INVALID");
   chosenItem(connection, "contact", contact.externalId); seen.add(contact.recipientId);
  }
  if (input.fxDate > now().slice(0, 10)) throw new ApiError(422, "Use a reviewed FX date that is not in the future", "ACCOUNTING_MAPPING_INVALID");
  const value: Mapping = { ...input, functionalCurrency: connection.currency }, version = row<{version:number}>("SELECT COALESCE(MAX(version),0)+1 AS version FROM accounting_mappings WHERE connection_id=?", id)!.version;
  db.prepare("INSERT INTO accounting_mappings(connection_id,version,entity_id,payload_ciphertext,created_by,created_at) VALUES(?,?,?,?,?,?)").run(id, version, connection.entity_id, encrypt(JSON.stringify(value)), live.userId, now());
  db.prepare("UPDATE accounting_jobs SET state='held',last_error='MAPPING_CHANGED',updated_at=? WHERE connection_id=? AND state IN ('review','queued')").run(now(), id);
  audit(live.userId, live.organizationId, "accounting.mapping_reviewed", id, { version, entityId: connection.entity_id }); return { version, value };
 });
}
interface Source { kind: "bill" | "settlement"; sourceId: string; billId: string; recipientId: string; amount: string; reference: string; title: string; date: string; dueDate:string; sourceDueAt:string|null; companyTimezone:string; hash: string; evidence: string[]; externalBillId?: string }
interface AccountingBill { id:string;reference:string;title:string;amount:string;recipient_id:string;accepted_at:string|null;status:string;setoff_amount:string;due_date:string|null }
function sourceTerms(access: AccessContext, connection: Connection, kind: "bill" | "settlement", id: string, date: string, reviewedDueDate?:string): Source {
 const bill = kind === "bill" ? row<AccountingBill>("SELECT * FROM bills WHERE id=? AND organization_id=?", id, access.organizationId)
  : row<AccountingBill>("SELECT b.* FROM bills b JOIN bill_installments i ON i.bill_id=b.id JOIN payments p ON p.id=i.payment_id WHERE p.id=? AND p.organization_id=? AND b.organization_id=?", id, access.organizationId, access.organizationId);
 if (!bill) throw new ApiError(404, "The company invoice or settlement was not found", "ACCOUNTING_SOURCE_NOT_FOUND");
 if (!bill.accepted_at || bill.status === "disputed" || bill.setoff_amount !== "0") throw new ApiError(409, "Accept the invoice through ordinary company review first. Disputes and noncash setoff require separate accounting review", "ACCOUNTING_SOURCE_HELD");
 const terms = getBillTerms(access, bill.id), profile = row<{ version: number }>("SELECT version FROM recipients WHERE id=? AND organization_id=?", bill.recipient_id, access.organizationId);
 const snapshot = terms.installments[0]?.recipient_version;
 if (!profile || snapshot !== profile.version) throw new ApiError(409, "The historical payee profile changed. Resolve its original accounting contact before posting", "ACCOUNTING_HISTORICAL_CONTACT_REQUIRED");
 const companyTimezone = row<{timezone:string}>("SELECT timezone FROM organizations WHERE id=?",access.organizationId)!.timezone;
 const sourceDueDate = bill.due_date ? companyDate(bill.due_date,companyTimezone) : null;
 if (sourceDueDate && reviewedDueDate && sourceDueDate !== reviewedDueDate) throw new ApiError(409,"The reviewed maturity differs from the original invoice. Resolve the original bill terms before posting","ACCOUNTING_DUE_DATE_CHANGED");
 let dueDate = sourceDueDate ?? reviewedDueDate, amount = bill.amount; const evidence: string[] = []; let externalBillId: string | undefined;
 if (kind === "settlement") {
  const payment = terms.installments.find(item => item.id === id);
  if (!payment || payment.status !== "paid" || payment.delivered_amount !== payment.amount || payment.amount === "0") throw new ApiError(409, "Only a fully satisfied installment with recorded delivery can become a settlement entry. Partial/provider-only states remain held", "ACCOUNTING_SETTLEMENT_UNVERIFIED");
  const attempts = rows<{ state: string; source_tx_hash: string | null; destination_tx_hash: string | null }>("SELECT state,source_tx_hash,destination_tx_hash FROM payout_attempts WHERE payment_id=? AND organization_id=? ORDER BY created_at,id", id, access.organizationId);
  if (!attempts.some(item => item.state === "delivered" && item.source_tx_hash)) throw new ApiError(409, "Inspect retained final settlement evidence before exporting payment", "ACCOUNTING_SETTLEMENT_UNVERIFIED");
  evidence.push(...attempts.filter(item => item.state === "delivered").flatMap(item => [item.source_tx_hash, item.destination_tx_hash].filter((value): value is string => !!value)));
  const posted = row<Job>("SELECT * FROM accounting_jobs WHERE connection_id=? AND entity_id=? AND kind='bill' AND source_id=? AND state='done'", connection.id, connection.entity_id, bill.id);
  if (!posted?.external_id) throw new ApiError(409, "Post and reconcile this bill before its payment", "ACCOUNTING_BILL_NOT_POSTED");
  if (posted.mapping_version !== currentMapping(connection)?.version) throw new ApiError(409, "The original bill uses another mapping or FX version. Reconcile the accounting change before posting payment", "ACCOUNTING_FX_REVIEW_REQUIRED");
  const original = JSON.parse(decrypt(posted.payload_ciphertext)) as {source:{dueDate?:string}};
  if (!original.source.dueDate || dueDate && dueDate !== original.source.dueDate) throw new ApiError(409,"The original bill maturity needs accounting review before its payment","ACCOUNTING_DUE_DATE_CHANGED");
  dueDate = original.source.dueDate;
  externalBillId = posted.external_id; amount = payment.amount;
 }
 if (!dueDate || !z.iso.date().safeParse(dueDate).success) throw new ApiError(409,"This invoice has no maturity date. Explicitly review a provider due date before preparing its accounting plan","ACCOUNTING_DUE_DATE_REQUIRED");
 const source = { kind, sourceId: id, billId: bill.id, recipientId: bill.recipient_id, amount, reference: bill.reference, title: decrypt(bill.title), date, dueDate, sourceDueAt:bill.due_date, companyTimezone, evidence, ...(externalBillId ? { externalBillId } : {}) };
 return { ...source, hash: digest({ source, acceptedAt: bill.accepted_at, recipientVersion: snapshot, installment: kind === "settlement" ? terms.installments.find(item => item.id === id) : null }) };
}
export function createAccountingPlan(access: AccessContext, id: string, data: unknown) {
 const live = accountingAccess(access), connection = connectionFor(live, id), input = z.object({ kind: z.enum(["bill", "settlement"]), sourceId: safeId, postingDate: z.iso.date(), dueDate:z.iso.date().optional() }).strict().parse(data);
 if (connection.status !== "active" || !connection.entity_id || !connection.currency) throw new ApiError(409, "Select an active accounting company", "ACCOUNTING_CONNECTION_REQUIRED");
 return transaction(db => {
  const mapping = currentMapping(connection);
  if (!mapping) throw new ApiError(409, "Review account, zero-tax and FX mappings first", "ACCOUNTING_MAPPING_REQUIRED");
  if (input.postingDate > now().slice(0, 10) || mapping.value.closedThrough && input.postingDate <= mapping.value.closedThrough) throw new ApiError(409, "The posting date is in the future or a company-declared closed period", "ACCOUNTING_PERIOD_CLOSED");
  const source = sourceTerms(live, connection, input.kind, input.sourceId, input.postingDate,input.dueDate), contact = mapping.value.contacts.find(item => item.recipientId === source.recipientId);
  if (!contact) throw new ApiError(409, "Map this original company payee to its accounting contact", "ACCOUNTING_CONTACT_REQUIRED");
  const expense = chosenItem(connection, "account", mapping.value.expenseAccountId), amount = functionalAmount(source.amount, mapping.value.fxNumerator, mapping.value.fxDenominator);
  const previous = row<Job>("SELECT * FROM accounting_jobs WHERE connection_id=? AND entity_id=? AND kind=? AND source_id=?", id, connection.entity_id, input.kind, input.sourceId);
  if (previous && !["review", "held"].includes(previous.state)) throw new ApiError(409, "Inspect this source's existing accounting request before creating another", "ACCOUNTING_REQUEST_EXISTS");
  if (previous?.attempts) throw new ApiError(409, "An attempted posting needs provider reconciliation. It cannot become a new request automatically", "ACCOUNTING_REQUEST_HELD");
  const jobId = previous?.id ?? randomUUID(), marker = previous?.marker ?? `RZ${digest(jobId).slice(0, 19)}`;
  const reference = `Razor ${source.kind} ${source.sourceId}; ${source.amount} microUSDC; FX ${mapping.value.fxNumerator}/${mapping.value.fxDenominator} ${connection.currency}/USDC; ${mapping.value.fxDate}; ${mapping.value.fxSource}; ${source.evidence.join(",")}`.slice(0, connection.provider === "xero" ? 255 : 1000);
  const payload = postingPayload(connection.provider, input.kind, { amount: amount.value, date: input.postingDate, dueDate:source.dueDate, marker, title: source.title, contactId: contact.externalId, expenseAccountId: connection.provider === "xero" ? expense.code! : expense.id, bankAccountId: mapping.value.bankAccountId, taxCodeId: mapping.value.taxCodeId, currency: connection.currency, externalBillId: source.externalBillId, reference });
  const posting = { payload, source, amount, functionalCurrency: connection.currency, fx: { numerator: mapping.value.fxNumerator, denominator: mapping.value.fxDenominator, source: mapping.value.fxSource, date: mapping.value.fxDate }, bankSettlementClaimed: false, payrollRowsIncluded: false };
  const reviewHash = digest({ jobId, connectionVersion: connection.version, entity: connection.entity_id, mappingVersion: mapping.version, posting });
  db.prepare("INSERT INTO accounting_jobs(id,organization_id,connection_id,entity_id,connection_version,mapping_version,kind,source_id,source_hash,marker,payload_ciphertext,review_hash,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,entity_id,kind,source_id) DO UPDATE SET connection_version=excluded.connection_version,mapping_version=excluded.mapping_version,source_hash=excluded.source_hash,payload_ciphertext=excluded.payload_ciphertext,review_hash=excluded.review_hash,state='review',created_by=excluded.created_by,approved_by=NULL,approved_at=NULL,last_error=NULL,updated_at=excluded.updated_at")
   .run(jobId, live.organizationId, id, connection.entity_id, connection.version, mapping.version, input.kind, input.sourceId, source.hash, marker, encrypt(JSON.stringify(posting)), reviewHash, live.userId, now(), now());
  audit(live.userId, live.organizationId, "accounting.plan_prepared", jobId, { kind: input.kind, sourceId: input.sourceId }); return { job: { ...jobFor(live, jobId), payload_ciphertext: undefined }, posting };
 });
}
export function approveAccountingPlan(access: AccessContext, id: string, reviewHash: string) {
 const live = accountingAccess(access, true);
 return transaction(db => {
  const job = jobFor(live, id), connection = connectionFor(live, job.connection_id), posting = JSON.parse(decrypt(job.payload_ciphertext)) as { source: Source };
  if (job.state !== "review" || job.review_hash !== reviewHash || connection.status !== "active" || connection.version !== job.connection_version || currentMapping(connection)?.version !== job.mapping_version || sourceTerms(live, connection, job.kind, job.source_id, posting.source.date,posting.source.dueDate).hash !== job.source_hash) throw new ApiError(409, "The source, mapping or company connection changed. Review a new posting plan", "ACCOUNTING_REVIEW_CHANGED");
  db.prepare("UPDATE accounting_jobs SET state='queued',approved_by=?,approved_at=?,updated_at=? WHERE id=? AND state='review'").run(live.userId, now(), now(), id);
  audit(live.userId, live.organizationId, "accounting.plan_approved", id, { reviewHash }); return { queued: true };
 });
}

interface Posting { payload: Record<string, unknown>; source: Source; amount: { text: string; value: number }; functionalCurrency: string }
function resultItems(connection: Connection, job: Job, body: unknown) {
 const value = body as Record<string, unknown>, key = connection.provider === "quickbooks" ? job.kind === "bill" ? "Bill" : "BillPayment" : job.kind === "bill" ? "Invoices" : "Payments";
 const items = connection.provider === "quickbooks" ? (value?.QueryResponse as Record<string, unknown>)?.[key] : value?.[key];
 if (items === undefined) return [];
 if (!Array.isArray(items) || items.length > 100) throw new ApiError(502, "The provider lookup was ambiguous", "ACCOUNTING_RESPONSE_INVALID");
 return items as Record<string, unknown>[];
}
function responseMatches(connection: Connection, job: Job, item: Record<string, unknown>) {
 const posting = JSON.parse(decrypt(job.payload_ciphertext)) as Posting;
 const providerDate = (value: unknown) => {
  if (typeof value !== "string") return null;
  const wrapped = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  if (!wrapped) return /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) ? value.slice(0, 10) : null;
  const parsed = new Date(Number(wrapped[1])); return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
 };
 if (connection.provider === "quickbooks") {
  type Line = { Amount?: number; DetailType?: string; LinkedTxn?: { TxnId?: string; TxnType?: string }[]; AccountBasedExpenseLineDetail?: { AccountRef?:{value?:string}; TaxCodeRef?:{value?:string} } };
  const payload = posting.payload as { VendorRef: { value: string }; CheckPayment?:{BankAccountRef?:{value?:string}}; Line: Line[] }, lines = item.Line as Line[] | undefined;
  const common = item.DocNumber === job.marker && item.TotalAmt === posting.amount.value && (item.VendorRef as { value?: string })?.value === payload.VendorRef.value
   && (item.CurrencyRef as { value?: string })?.value === posting.functionalCurrency && providerDate(item.TxnDate) === posting.source.date;
  if (!common || !Array.isArray(lines) || lines.length !== 1 || lines[0].Amount !== posting.amount.value) return false;
  if (job.kind === "settlement") return item.PayType === "Check" && (item.CheckPayment as {BankAccountRef?:{value?:string}})?.BankAccountRef?.value === payload.CheckPayment?.BankAccountRef?.value && lines[0].LinkedTxn?.length === 1 && lines[0].LinkedTxn[0].TxnId === posting.source.externalBillId && lines[0].LinkedTxn[0].TxnType === "Bill";
  return providerDate(item.DueDate) === posting.source.dueDate && lines[0].DetailType === "AccountBasedExpenseLineDetail" && lines[0].AccountBasedExpenseLineDetail?.AccountRef?.value === payload.Line[0].AccountBasedExpenseLineDetail?.AccountRef?.value && lines[0].AccountBasedExpenseLineDetail?.TaxCodeRef?.value === payload.Line[0].AccountBasedExpenseLineDetail?.TaxCodeRef?.value;
 }
 if (job.kind === "bill") {
  type Line = { Quantity?:number; UnitAmount?:number; AccountCode?:string; TaxType?:string; TaxAmount?:number };
  const expected = (posting.payload as { Invoices: { Contact: { ContactID: string }; LineItems:Line[] }[] }).Invoices[0], lines = item.LineItems as Line[] | undefined;
  return item.InvoiceNumber === job.marker && item.Type === "ACCPAY" && !["DELETED", "VOIDED"].includes(String(item.Status)) && item.Total === posting.amount.value && item.CurrencyCode === posting.functionalCurrency && (item.Contact as { ContactID?: string })?.ContactID === expected.Contact.ContactID
   && providerDate(item.DateString ?? item.Date) === posting.source.date && providerDate(item.DueDateString ?? item.DueDate) === posting.source.dueDate && item.LineAmountTypes === "Exclusive" && Array.isArray(lines) && lines.length === 1 && lines[0].Quantity === 1 && lines[0].UnitAmount === posting.amount.value && lines[0].AccountCode === expected.LineItems[0].AccountCode && lines[0].TaxType === expected.LineItems[0].TaxType && (lines[0].TaxAmount ?? 0) === 0;
 }
 const expected = (posting.payload as { Payments: { Account: { AccountID: string } }[] }).Payments[0];
 return item.Reference === job.marker && item.Status !== "DELETED" && providerDate(item.Date) === posting.source.date && item.Amount === posting.amount.value && (item.Invoice as { InvoiceID?: string })?.InvoiceID === posting.source.externalBillId && (item.Account as { AccountID?: string })?.AccountID === expected.Account.AccountID;
}
function recordObserved(connection: Connection, job: Job, item: Record<string, unknown>, attach: boolean) {
 const wrapped = connection.provider === "quickbooks" ? { [job.kind === "bill" ? "Bill" : "BillPayment"]: item } : { [job.kind === "bill" ? "Invoices" : "Payments"]: [item] };
 const parsed = externalObject(connection.provider, job.kind, wrapped), matches = responseMatches(connection, job, item), providerHash = digest(item);
 return transaction(db => {
  const current = row<Job>("SELECT * FROM accounting_jobs WHERE id=?", job.id)!;
  const changed = !!current.provider_hash && current.provider_hash !== providerHash;
  const state = matches && (!changed || attach) ? "matched" : "conflict";
  db.prepare("INSERT INTO accounting_observations(connection_id,entity_id,kind,external_id,revision,payload_ciphertext,state,matching_job_id,observed_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,entity_id,kind,external_id) DO UPDATE SET revision=excluded.revision,payload_ciphertext=excluded.payload_ciphertext,state=excluded.state,matching_job_id=excluded.matching_job_id,observed_at=excluded.observed_at")
   .run(connection.id, connection.entity_id, job.kind, parsed.id, parsed.revision, encrypt(JSON.stringify(item)), state, job.id, now());
  if (!matches || changed && !attach) db.prepare("UPDATE accounting_jobs SET state='held',last_error='EXTERNAL_RECORD_CHANGED',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(now(), job.id);
  else if (attach) db.prepare("UPDATE accounting_jobs SET state='done',external_id=?,external_revision=?,provider_hash=?,lease_owner=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=?").run(parsed.id, parsed.revision, providerHash, now(), job.id);
  return { matched: state === "matched", externalId: parsed.id, revision: parsed.revision, state };
 });
}
async function lookupJob(connection: Connection, job: Job, transport: AccountingTransport) {
 const entity = collection(connection.provider, job.kind);
 const path = connection.provider === "quickbooks" ? `/query?query=${encodeURIComponent(`SELECT * FROM ${job.kind === "bill" ? "Bill" : "BillPayment"} WHERE DocNumber = '${job.marker}' MAXRESULTS 100`)}`
  : `/${entity}?where=${encodeURIComponent(`${job.kind === "bill" ? "InvoiceNumber" : "Reference"}=="${job.marker}"`)}`;
 const response = await providerRead(connection, path, transport);
 if (response.status !== 200) throw new ApiError(response.status === 429 ? 429 : 502, "The provider could not reconcile this posting. Its recorded outcome is unchanged", "ACCOUNTING_RECONCILIATION_UNAVAILABLE");
 return resultItems(connection, job, response.body).filter(item => item[connection.provider === "quickbooks" ? "DocNumber" : job.kind === "bill" ? "InvoiceNumber" : "Reference"] === job.marker);
}
export async function reconcileAccountingJob(access: AccessContext, id: string, acknowledgeMatchingRevision = false, transport: AccountingTransport = accountingTransport) {
 const live = accountingAccess(access, acknowledgeMatchingRevision), job = jobFor(live, id), connection = connectionFor(live, job.connection_id);
 if (!connection.entity_id || connection.entity_id !== job.entity_id) throw new ApiError(409, "Restore the original verified company connection before reconciling this request", "ACCOUNTING_CONNECTION_CHANGED");
 if (["preflight", "dispatching"].includes(job.state) && job.lease_until && job.lease_until > now()) throw new ApiError(409, "This posting is still being inspected or sent. Wait before reconciliation", "ACCOUNTING_REQUEST_BUSY");
 const items = await lookupJob(connection, job, transport);
 accountingAccess(live, acknowledgeMatchingRevision);
 if (items.length !== 1) {
  getDb().prepare("UPDATE accounting_jobs SET state='unknown',last_error=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND attempts>0").run(items.length ? "AMBIGUOUS_PROVIDER_MATCH" : "NO_PROVIDER_MATCH_YET", now(), id);
  return { matched: false, held: true, note: "A missing or ambiguous lookup does not prove that no write occurred. Inspect the provider account; this request will not be posted again automatically." };
 }
 const result = recordObserved(connection, job, items[0], job.state === "unknown" || acknowledgeMatchingRevision || !job.external_id);
 if (acknowledgeMatchingRevision) audit(live.userId, live.organizationId, "accounting.external_revision_reviewed", id, { externalId: result.externalId, matched: result.matched });
 return result;
}
async function verifyRemoteMapping(connection: Connection, mapping: Mapping, contactId: string, transport: AccountingTransport) {
 const token = await accessToken(connection, transport), headers = apiHeaders(connection, token);
 const taxPath = connection.provider === "quickbooks" ? `/taxcode/${encodeURIComponent(mapping.taxCodeId)}` : "/TaxRates";
 const tax = await transport({ url: apiBase(connection) + taxPath, method: "GET", headers });
 if (tax.status !== 200) throw new ApiError(409, "The provider tax mapping could not be revalidated", "ACCOUNTING_MAPPING_STALE");
 const qb = tax.body as { TaxCode?: { Id?: string; Active?: boolean; Taxable?: boolean } };
 const xr = tax.body as { TaxRates?: { TaxType?: string; EffectiveRate?: number; Status?: string }[] };
 const zero = connection.provider === "quickbooks" ? qb.TaxCode?.Id === mapping.taxCodeId && qb.TaxCode.Taxable === false && qb.TaxCode.Active !== false : xr.TaxRates?.some(item => item.TaxType === mapping.taxCodeId && item.EffectiveRate === 0 && item.Status !== "DELETED" && item.Status !== "ARCHIVED");
 if (!zero) throw new ApiError(409, "The selected tax code changed. Review a supported zero-tax mapping before posting", "ACCOUNTING_MAPPING_STALE");
 const contact = await transport({ url: apiBase(connection) + `/${connection.provider === "quickbooks" ? "vendor" : "Contacts"}/${encodeURIComponent(contactId)}`, method: "GET", headers });
 const contactBody = contact.body as { Vendor?: { Id?:string;Active?:boolean };Contacts?:{ContactID?:string;ContactStatus?:string}[] };
 const contactValid = connection.provider === "quickbooks" ? contactBody.Vendor?.Id === contactId && contactBody.Vendor.Active !== false : contactBody.Contacts?.[0]?.ContactID === contactId && contactBody.Contacts[0].ContactStatus !== "ARCHIVED";
 if (contact.status !== 200 || !contactValid) throw new ApiError(409, "The mapped accounting contact needs review", "ACCOUNTING_MAPPING_STALE");
 for (const [id, bank] of [[mapping.expenseAccountId, false], [mapping.bankAccountId, true]] as const) {
  const result = await transport({ url: apiBase(connection) + `/${connection.provider === "quickbooks" ? "account" : "Accounts"}/${encodeURIComponent(id)}`, method: "GET", headers });
  const data = result.body as { Account?:Record<string,unknown>;Accounts?:Record<string,unknown>[] }, account = connection.provider === "quickbooks" ? data.Account : data.Accounts?.[0];
  const kind = String(account?.AccountType ?? account?.Type ?? "").toLowerCase().replace(/[^a-z]/g, ""), currency = (account?.CurrencyRef as {value?:string})?.value ?? account?.CurrencyCode;
  const expected = chosenItem(connection, "account", id);
  if (result.status !== 200 || !account || (account.Id ?? account.AccountID) !== id || account.Active === false || account.Status === "ARCHIVED" || (bank ? kind !== "bank" || currency && currency !== connection.currency : !["expense", "otherexpense", "costofgoodssold", "directcosts", "overheads"].includes(kind) || connection.provider === "xero" && account.Code !== expected.code)) throw new ApiError(409, "The selected account changed. Refresh and review mappings before posting", "ACCOUNTING_MAPPING_STALE");
 }
 return token;
}
export async function dispatchAccountingJobs(options: { organizationId?: string; maxJobs?: number; transport?: AccountingTransport } = {}) {
 const transport = options.transport ?? accountingTransport, results: { id: string; state: string }[] = [];
 const limit = Math.max(1, Math.min(5, options.maxJobs ?? 1));
 for (let index = 0; index < limit; index++) {
  const job = transaction(db => {
   db.prepare("UPDATE accounting_jobs SET state='unknown',lease_owner=NULL,lease_until=NULL,last_error='WRITE_OUTCOME_UNCONFIRMED',updated_at=? WHERE state='dispatching' AND lease_until<=? AND (? IS NULL OR organization_id=?)").run(now(), now(), options.organizationId ?? null, options.organizationId ?? null);
   db.prepare("UPDATE accounting_jobs SET state='queued',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE state='preflight' AND lease_until<=? AND (? IS NULL OR organization_id=?)").run(now(), now(), options.organizationId ?? null, options.organizationId ?? null);
   const value = row<Job>("SELECT * FROM accounting_jobs j WHERE j.state='queued' AND (? IS NULL OR j.organization_id=?) AND NOT EXISTS(SELECT 1 FROM accounting_jobs x WHERE x.connection_id=j.connection_id AND x.state IN ('preflight','dispatching') AND x.lease_until>?) ORDER BY j.created_at,j.id LIMIT 1", options.organizationId ?? null, options.organizationId ?? null, now());
   if (!value) return null;
   value.lease_owner = randomUUID(); value.lease_until = new Date(Date.now() + 90000).toISOString();
   db.prepare("UPDATE accounting_jobs SET state='preflight',lease_owner=?,lease_until=?,updated_at=? WHERE id=? AND state='queued'").run(value.lease_owner, value.lease_until, now(), value.id); return value;
  });
  if (!job) break;
  let writeStarted = false;
  try {
   const creator = accountingAccess({ userId: job.created_by, organizationId: job.organization_id, permissions: [] });
   if (!job.approved_by) throw new Error("NO_POSTING_APPROVAL");
   accountingAccess({ userId: job.approved_by, organizationId: job.organization_id, permissions: [] }, true);
   const connection = connectionFor(creator, job.connection_id), mapping = currentMapping(connection), posting = JSON.parse(decrypt(job.payload_ciphertext)) as Posting;
   if (!mapping || connection.status !== "active" || connection.version !== job.connection_version || connection.entity_id !== job.entity_id || mapping.version !== job.mapping_version || sourceTerms(creator, connection, job.kind, job.source_id, posting.source.date,posting.source.dueDate).hash !== job.source_hash) throw new ApiError(409, "Review changed source, mapping or connection before posting", "ACCOUNTING_REVIEW_CHANGED");
   const previous = await lookupJob(connection, job, transport);
   if (previous.length) {
    if (previous.length !== 1) throw new ApiError(409, "Multiple provider records use this request marker", "ACCOUNTING_PROVIDER_CONFLICT");
    const result = recordObserved(connection, job, previous[0], true); results.push({ id: job.id, state: result.matched ? "done" : "held" }); continue;
   }
   const contact = mapping.value.contacts.find(item => item.recipientId === posting.source.recipientId);
   if (!contact) throw new ApiError(409, "The source's contact mapping changed", "ACCOUNTING_MAPPING_STALE");
   const token = await verifyRemoteMapping(connection, mapping.value, contact.externalId, transport);
   if (job.kind === "settlement") {
    const response = await providerRead(connection, `/${collection(connection.provider, "bill")}/${encodeURIComponent(posting.source.externalBillId!)}`, transport);
    const external = externalObject(connection.provider, "bill", response.body).item;
    const original = row<Job>("SELECT * FROM accounting_jobs WHERE connection_id=? AND entity_id=? AND kind='bill' AND source_id=? AND state='done'", connection.id, connection.entity_id, posting.source.billId);
    const due = connection.provider === "quickbooks" ? external.Balance : external.AmountDue;
    if (response.status !== 200 || !original || !responseMatches(connection, original, external) || typeof due !== "number" || due < posting.amount.value || connection.provider === "xero" && external.Status !== "AUTHORISED") throw new ApiError(409, "Review the external bill's original terms, authorization and remaining balance before recording payment", "ACCOUNTING_EXTERNAL_BILL_HELD");
   }
   transaction(db => {
    accountingAccess(creator); accountingAccess({ userId: job.approved_by!, organizationId: job.organization_id, permissions: [] }, true);
    const current = connectionFor(creator, connection.id);
    if (current.status !== "active" || current.version !== job.connection_version || currentMapping(current)?.version !== job.mapping_version || sourceTerms(creator, current, job.kind, job.source_id, posting.source.date,posting.source.dueDate).hash !== job.source_hash) throw new ApiError(409, "Posting terms changed during provider checks", "ACCOUNTING_REVIEW_CHANGED");
    const changed = db.prepare("UPDATE accounting_jobs SET state='dispatching',attempts=attempts+1,write_started_at=?,updated_at=? WHERE id=? AND lease_owner=? AND state='preflight' AND lease_until>?").run(now(), now(), job.id, job.lease_owner, now());
    if (!changed.changes) throw new ApiError(409, "The posting worker lease expired", "ACCOUNTING_REQUEST_BUSY");
   });
   writeStarted = true;
   const url = `${apiBase(connection)}/${collection(connection.provider, job.kind)}${connection.provider === "quickbooks" ? `?requestid=${job.id}` : ""}`;
   const response = await transport({ url, method: "POST", headers: { ...apiHeaders(connection, token), ...(connection.provider === "xero" ? { "Idempotency-Key": job.id } : {}) }, body: canonical(posting.payload) });
   if (response.status < 200 || response.status >= 300) throw new ApiError(502, "The provider did not confirm the write. Reconcile its existing request before another action", "ACCOUNTING_WRITE_UNCONFIRMED");
   const saved = externalObject(connection.provider, job.kind, response.body), result = recordObserved(connection, job, saved.item, true);
   results.push({ id: job.id, state: result.matched ? "done" : "held" });
  } catch (error) {
   const code = error instanceof ApiError ? error.code : writeStarted ? "WRITE_OUTCOME_UNCONFIRMED" : "PREFLIGHT_UNAVAILABLE";
   const state = writeStarted ? "unknown" : "held";
   getDb().prepare("UPDATE accounting_jobs SET state=?,last_error=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_owner=?").run(state, code, now(), job.id, job.lease_owner);
   results.push({ id: job.id, state });
  }
 }
 return { processed: results.length, jobs: results };
}
export function retryAccountingPreflight(access: AccessContext, id: string) {
 const live = accountingAccess(access, true), job = jobFor(live, id);
 if (job.state !== "held" || job.attempts || !job.approved_by) throw new ApiError(409, "Attempted writes require read-only reconciliation. Prepare a new review for changed terms", "ACCOUNTING_REQUEST_HELD");
 getDb().prepare("UPDATE accounting_jobs SET state='queued',last_error=NULL,updated_at=? WHERE id=? AND state='held' AND attempts=0").run(now(), id);
 audit(live.userId, live.organizationId, "accounting.preflight_retry", id); return { queued: true };
}
