import { reserveOptionalCreation } from "../billing/capabilities";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt, hashToken, newToken } from "../identity/crypto";
import { appOrigin, audit } from "../identity/session";
import { accountingAccess } from "../accounting/service";
import { canonical, digest } from "../accounting/model";
import {
  valuedAsset,
  valuationInput,
  type FeeBatch,
} from "../accounting/ledger";
import {
  accountDomain,
  apiBase,
  authEndpoint,
  basicAuth,
  catalogPage,
  headers,
  journalSchema,
  recordId,
  schemaObject,
  settings,
  tokenResponse,
  transportFor,
  type CatalogRecord,
} from "./provider";

interface Connection {
  id: string;
  organization_id: string;
  account_domain: string;
  created_by: string;
  status: string;
  version: number;
  token_ciphertext: string | null;
  expires_at: string | null;
  refresh_owner: string | null;
  refresh_until: string | null;
  catalog_ciphertext: string | null;
  catalog_hash: string | null;
  catalog_at: string | null;
  mapping_ciphertext: string | null;
  mapping_version: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
interface Mapping {
  subsidiaryId: string;
  subsidiaryName: string;
  currencyId: string;
  currencyCode: string;
  expenseAccountId: string;
  clearingAccountId: string;
  schemaHash: string;
  taxPolicy: "non_tax_journal_only";
  closedThrough: string | null;
  legalEntityReference: string;
  accountsHash: string;
  reviewedBy: string;
}
interface Catalog {
  records: CatalogRecord[];
  schema: unknown;
  schemaSupported: boolean;
  schemaError: string | null;
  taxAvailable: boolean;
  taxReason: string | null;
  observedAt: string;
  hasMore: boolean;
}
interface Job {
  id: string;
  organization_id: string;
  connection_id: string;
  connection_version: number;
  mapping_version: number;
  source_id: string;
  source_hash: string;
  external_id: string;
  payload_ciphertext: string;
  review_hash: string;
  state: string;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  attempts: number;
  lease_owner: string | null;
  lease_until: string | null;
  provider_id: string | null;
  provider_hash: string | null;
  observed_ciphertext: string | null;
  last_error: string | null;
}
const now = () => new Date().toISOString(),
  inputId = z.string().min(1).max(128),
  recordBase = "/services/rest/record/v1/";
function connection(access: AccessContext) {
  const value = row<Connection>(
    "SELECT * FROM netsuite_connections WHERE organization_id=?",
    access.organizationId,
  );
  if (!value)
    throw new ApiError(
      404,
      "No NetSuite account has been connected for this company",
      "NETSUITE_NOT_CONNECTED",
    );
  return value;
}
function session(userId: string, id: string) {
  if (
    !row(
      "SELECT id FROM sessions WHERE id=? AND user_id=? AND expires_at>?",
      id,
      userId,
      now(),
    )
  )
    throw new ApiError(
      401,
      "Start NetSuite consent again from an active company session",
      "NETSUITE_SESSION_EXPIRED",
    );
}
function mapping(c: Connection) {
  return c.mapping_ciphertext
    ? (JSON.parse(decrypt(c.mapping_ciphertext)) as Mapping)
    : null;
}
function safe(c: Connection) {
  const {
    token_ciphertext: _token,
    refresh_owner: _owner,
    refresh_until: _until,
    catalog_ciphertext,
    mapping_ciphertext,
    ...value
  } = c;
  return {
    ...value,
    mapping: mapping_ciphertext
      ? (JSON.parse(decrypt(mapping_ciphertext)) as Mapping)
      : null,
    catalog: catalog_ciphertext
      ? (JSON.parse(decrypt(catalog_ciphertext)) as Catalog)
      : null,
  };
}
function fresh(c: Connection) {
  const current = row<Connection>(
    "SELECT * FROM netsuite_connections WHERE id=? AND organization_id=?",
    c.id,
    c.organization_id,
  );
  if (
    !current ||
    current.version !== c.version ||
    current.account_domain !== c.account_domain ||
    current.status !== c.status
  )
    throw new ApiError(
      409,
      "The NetSuite account grant changed. Refresh before continuing",
      "NETSUITE_CONNECTION_CHANGED",
    );
  return current;
}
async function request(
  c: Connection,
  path: string,
  token: string,
  accept = "application/json",
) {
  const response = await transportFor(c.account_domain)({
    url: apiBase(c.account_domain) + path,
    method: "GET",
    headers: headers(token, { accept }),
  });
  if (response.status !== 200)
    throw new ApiError(
      response.status === 429 ? 429 : 502,
      "NetSuite did not expose this required account record or schema",
      "NETSUITE_RECORD_UNAVAILABLE",
    );
  return response.body;
}
async function token(c: Connection) {
  c = fresh(c);
  if (!c.token_ciphertext || c.status !== "active")
    throw new ApiError(
      409,
      "Connect an active NetSuite grant first",
      "NETSUITE_NOT_CONNECTED",
    );
  accountingAccess({
    userId: c.created_by,
    organizationId: c.organization_id,
    permissions: [],
  });
  const stored = JSON.parse(decrypt(c.token_ciphertext)) as {
    accessToken: string;
    refreshToken: string;
  };
  if (c.expires_at && c.expires_at > new Date(Date.now() + 60000).toISOString())
    return stored.accessToken;
  const lease = randomUUID();
  transaction((db) => {
    const value = fresh(c);
    if (value.refresh_until && value.refresh_until > now())
      throw new ApiError(
        409,
        "NetSuite credentials are already refreshing. Retry shortly",
        "NETSUITE_REFRESH_BUSY",
      );
    db.prepare(
      "UPDATE netsuite_connections SET refresh_owner=?,refresh_until=? WHERE id=? AND version=?",
    ).run(lease, new Date(Date.now() + 30000).toISOString(), c.id, c.version);
  });
  try {
    const response = await transportFor(c.account_domain)({
      url: authEndpoint(c.account_domain, "token"),
      method: "POST",
      headers: {
        authorization: basicAuth(),
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
      }).toString(),
    });
    if (response.status !== 200) throw new Error("REFRESH_NOT_CONFIRMED");
    const next = tokenResponse(response.body, stored.refreshToken);
    transaction((db) => {
      accountingAccess({
        userId: c.created_by,
        organizationId: c.organization_id,
        permissions: [],
      });
      const result = db
        .prepare(
          "UPDATE netsuite_connections SET token_ciphertext=?,expires_at=?,refresh_owner=NULL,refresh_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND version=? AND refresh_owner=? AND status='active'",
        )
        .run(
          encrypt(JSON.stringify(next.tokens)),
          next.expiresAt,
          now(),
          c.id,
          c.version,
          lease,
        );
      if (!result.changes) throw new Error("GRANT_CHANGED");
    });
    return next.tokens.accessToken;
  } catch {
    getDb()
      .prepare(
        "UPDATE netsuite_connections SET status='reauthorize',refresh_owner=NULL,refresh_until=NULL,last_error='REFRESH_NOT_CONFIRMED',updated_at=? WHERE id=? AND refresh_owner=?",
      )
      .run(now(), c.id, lease);
    throw new ApiError(
      409,
      "NetSuite token refresh is unconfirmed. Reauthorize without replaying financial requests",
      "NETSUITE_REAUTHORIZE_REQUIRED",
    );
  }
}
export function beginNetSuite(
  access: AccessContext,
  data: unknown,
  browserNonce: string,
  sessionId: string,
) {
  const live = accountingAccess(access),
    input = z
      .object({ accountId: z.string().min(3).max(50) })
      .strict()
      .parse(data),
    domain = accountDomain(input.accountId),
    config = settings();
  if (!config.configured)
    throw new ApiError(
      503,
      "Configure the confidential NETSUITE_CLIENT_ID and NETSUITE_CLIENT_SECRET first",
      "NETSUITE_SETUP_REQUIRED",
    );
  if (!/^[A-Za-z0-9_-]{43}$/.test(browserNonce))
    throw new ApiError(
      422,
      "Start consent in this browser",
      "NETSUITE_BROWSER_REQUIRED",
    );
  session(live.userId, sessionId);
  const state = newToken(),
    verifier = newToken();
  transaction((db) => {
    const previous = row<Connection>(
      "SELECT * FROM netsuite_connections WHERE organization_id=?",
      live.organizationId,
    );
    if (
      previous &&
      previous.account_domain !== domain &&
      (previous.token_ciphertext ||
        row("SELECT id FROM netsuite_jobs WHERE connection_id=?", previous.id))
    )
      throw new ApiError(
        409,
        "This company connection and its journal history stay bound to the original NetSuite account. Use the original account for reconciliation",
        "NETSUITE_ACCOUNT_FIXED",
      );
    const id = previous?.id ?? randomUUID();
    db.prepare(
      "INSERT INTO netsuite_connections(id,organization_id,account_domain,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET status='pending',version=version+1,account_domain=excluded.account_domain,created_by=excluded.created_by,catalog_ciphertext=NULL,catalog_hash=NULL,catalog_at=NULL,mapping_ciphertext=NULL,updated_at=excluded.updated_at",
    ).run(id, live.organizationId, domain, live.userId, now(), now());
    const c = connection(live);
    db.prepare(
      "UPDATE netsuite_oauth_states SET consumed_at=? WHERE connection_id=? AND consumed_at IS NULL",
    ).run(now(), id);
    db.prepare(
      "UPDATE netsuite_jobs SET state='held',last_error='GRANT_CHANGED',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE connection_id=? AND state IN ('review','queued','preflight') AND attempts=0",
    ).run(now(), id);
    db.prepare(
      "INSERT INTO netsuite_oauth_states(state_hash,connection_id,connection_version,user_id,session_id,browser_nonce_hash,verifier_ciphertext,expires_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      hashToken(state),
      id,
      c.version,
      live.userId,
      sessionId,
      hashToken(browserNonce),
      encrypt(verifier),
      new Date(Date.now() + 600000).toISOString(),
    );
    audit(live.userId, live.organizationId, "netsuite.consent_requested", id);
  });
  const url = new URL(
    `https://${domain}.app.netsuite.com/app/login/oauth2/authorize.nl`,
  );
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: "rest_webservices",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    prompt: "consent",
  }).toString();
  return { authorizationUrl: url.toString(), expiresInSeconds: 600 };
}
export async function finishNetSuite(
  data: unknown,
  browserNonce: string | undefined,
) {
  const input = z
    .object({
      state: z.string().min(1).max(200),
      code: z.string().min(1).max(4096).optional(),
      company: z.string().max(50).optional(),
      error: z.string().max(200).optional(),
    })
    .passthrough()
    .parse(data);
  if (!browserNonce || !/^[A-Za-z0-9_-]{43}$/.test(browserNonce))
    throw new ApiError(
      409,
      "Return to the same browser that requested NetSuite consent",
      "NETSUITE_BROWSER_REQUIRED",
    );
  const held = transaction((db) => {
    const value = row<{
      connection_id: string;
      connection_version: number;
      user_id: string;
      session_id: string;
      verifier_ciphertext: string;
    }>(
      "SELECT * FROM netsuite_oauth_states WHERE state_hash=? AND browser_nonce_hash=? AND consumed_at IS NULL AND expires_at>?",
      hashToken(input.state),
      hashToken(browserNonce),
      now(),
    );
    if (!value)
      throw new ApiError(
        409,
        "This NetSuite consent request expired or was consumed",
        "NETSUITE_STATE_INVALID",
      );
    const c = row<Connection>(
      "SELECT * FROM netsuite_connections WHERE id=?",
      value.connection_id,
    );
    if (
      !c ||
      c.version !== value.connection_version ||
      c.status !== "pending" ||
      c.created_by !== value.user_id
    )
      throw new ApiError(
        409,
        "The NetSuite consent request changed",
        "NETSUITE_STATE_INVALID",
      );
    session(value.user_id, value.session_id);
    accountingAccess({
      userId: value.user_id,
      organizationId: c.organization_id,
      permissions: [],
    });
    db.prepare(
      "UPDATE netsuite_oauth_states SET consumed_at=? WHERE state_hash=? AND consumed_at IS NULL",
    ).run(now(), hashToken(input.state));
    return {
      c,
      sessionId: value.session_id,
      verifier: decrypt(value.verifier_ciphertext),
    };
  });
  if (
    input.error ||
    !input.code ||
    !input.company ||
    accountDomain(input.company) !== held.c.account_domain
  ) {
    getDb()
      .prepare(
        "UPDATE netsuite_connections SET status='reauthorize',last_error='CONSENT_NOT_COMPLETED',updated_at=? WHERE id=? AND version=?",
      )
      .run(now(), held.c.id, held.c.version);
    throw new ApiError(
      409,
      "NetSuite consent did not match the requested account. Start again",
      "NETSUITE_CONSENT_NOT_COMPLETED",
    );
  }
  const response = await transportFor(held.c.account_domain)({
    url: authEndpoint(held.c.account_domain, "token"),
    method: "POST",
    headers: {
      authorization: basicAuth(),
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: settings().redirectUri,
      code_verifier: held.verifier,
    }).toString(),
  });
  if (response.status !== 200)
    throw new ApiError(
      502,
      "NetSuite did not confirm the account-specific OAuth grant",
      "NETSUITE_AUTH_FAILED",
    );
  const granted = tokenResponse(response.body);
  transaction((db) => {
    session(held.c.created_by, held.sessionId);
    accountingAccess({
      userId: held.c.created_by,
      organizationId: held.c.organization_id,
      permissions: [],
    });
    const changed = db
      .prepare(
        "UPDATE netsuite_connections SET token_ciphertext=?,expires_at=?,status='active',last_error=NULL,updated_at=? WHERE id=? AND version=? AND status='pending'",
      )
      .run(
        encrypt(JSON.stringify(granted.tokens)),
        granted.expiresAt,
        now(),
        held.c.id,
        held.c.version,
      );
    if (!changed.changes)
      throw new ApiError(
        409,
        "The NetSuite company request changed during consent",
        "NETSUITE_CONNECTION_CHANGED",
      );
  });
  return { organizationId: held.c.organization_id };
}
async function resolved(
  node: unknown,
  root: Record<string, unknown>,
  c: Connection,
  accessToken: string,
  depth = 0,
): Promise<{
  node: Record<string, unknown>;
  document: Record<string, unknown>;
}> {
  if (depth > 6)
    throw new ApiError(
      409,
      "The journal schema exceeds its supported reference depth",
      "NETSUITE_SCHEMA_UNSUPPORTED",
    );
  const value = schemaObject(node);
  if (!value.$ref) return { node: value, document: root };
  if (typeof value.$ref !== "string")
    throw new ApiError(
      409,
      "The schema reference is unsupported",
      "NETSUITE_SCHEMA_UNSUPPORTED",
    );
  if (value.$ref.startsWith("#/")) {
    let result: unknown = root;
    for (const part of value.$ref.slice(2).split("/"))
      result =
        schemaObject(result)[part.replaceAll("~1", "/").replaceAll("~0", "~")];
    return resolved(result, root, c, accessToken, depth + 1);
  }
  const url = new URL(value.$ref, apiBase(c.account_domain) + "/");
  if (
    url.origin !== new URL(apiBase(c.account_domain)).origin ||
    url.username ||
    url.password ||
    url.port ||
    !/^\/services\/rest\/record\/v1\/metadata-catalog\/[A-Za-z0-9_-]+$/.test(
      url.pathname,
    ) ||
    url.search ||
    url.hash
  )
    throw new ApiError(
      409,
      "The journal schema references unsupported remote metadata",
      "NETSUITE_SCHEMA_UNSUPPORTED",
    );
  const document = schemaObject(
    await request(
      c,
      url.pathname.slice(recordBase.length - 1),
      accessToken,
      "application/schema+json",
    ),
  );
  return resolved(document, document, c, accessToken, depth + 1);
}
async function currentSchema(c: Connection, accessToken: string) {
  const root = schemaObject(
      await request(
        c,
        "/metadata-catalog/journalentry",
        accessToken,
        "application/schema+json",
      ),
    ),
    properties = schemaObject(root.properties),
    line = await resolved(properties.line, root, c, accessToken),
    items = await resolved(
      schemaObject(line.node.properties).items,
      line.document,
      c,
      accessToken,
    ),
    element = await resolved(items.node.items, items.document, c, accessToken);
  const snapshot = {
    root,
    lineCollection: line.node,
    lineItems: items.node,
    lineElement: element.node,
  };
  journalSchema(snapshot);
  return snapshot;
}
export async function refreshNetSuiteCatalog(
  access: AccessContext,
  data: unknown,
) {
  const live = accountingAccess(access),
    c = connection(live),
    input = z
      .object({ page: z.number().int().min(1).max(100).default(1) })
      .strict()
      .parse(data),
    accessToken = await token(c);
  let schema: unknown = null,
    schemaError: string | null = null;
  try {
    schema = await currentSchema(c, accessToken);
  } catch (error) {
    schemaError =
      error instanceof ApiError
        ? error.message
        : "The live journal metadata is unavailable";
  }
  const records: CatalogRecord[] = [];
  let hasMore = false;
  for (const kind of ["subsidiary", "account", "currency"] as const) {
    const page = catalogPage(
      await request(
        c,
        `/${kind}?limit=100&offset=${(input.page - 1) * 100}`,
        accessToken,
      ),
      kind,
    );
    records.push(...page.records);
    hasMore ||= page.hasMore;
  }
  let taxAvailable = false,
    taxReason: string | null = null;
  try {
    const page = catalogPage(
      await request(
        c,
        `/taxtype?limit=100&offset=${(input.page - 1) * 100}`,
        accessToken,
      ),
      "tax",
    );
    records.push(...page.records);
    taxAvailable = true;
  } catch {
    taxReason =
      "No supported tax-type catalog is accessible under this grant. This connector permits only explicitly reviewed non-tax journals, and never supplies or infers tax fields.";
  }
  const previous = c.catalog_ciphertext
      ? (JSON.parse(decrypt(c.catalog_ciphertext)) as Catalog)
      : null,
    combined =
      input.page > 1 && previous
        ? new Map(
            previous.records.map((item) => [`${item.kind}:${item.id}`, item]),
          )
        : new Map<string, CatalogRecord>();
  for (const item of records) combined.set(`${item.kind}:${item.id}`, item);
  if (combined.size > 2000)
    throw new ApiError(
      409,
      "Narrow the NetSuite role's catalog scope before importing more than 2000 mapped records",
      "NETSUITE_CATALOG_LIMIT",
    );
  const catalog: Catalog = {
      records: [...combined.values()],
      schema,
      schemaSupported: !schemaError,
      schemaError,
      taxAvailable,
      taxReason,
      observedAt: now(),
      hasMore,
    },
    fingerprint = digest(schema);
  transaction((db) => {
    accountingAccess(live);
    fresh(c);
    db.prepare(
      "UPDATE netsuite_connections SET catalog_ciphertext=?,catalog_hash=?,catalog_at=?,last_error=?,updated_at=? WHERE id=? AND version=? AND status='active'",
    ).run(
      encrypt(JSON.stringify(catalog)),
      fingerprint,
      now(),
      schemaError ? "JOURNAL_SCHEMA_HELD" : null,
      now(),
      c.id,
      c.version,
    );
  });
  return { catalog };
}
function source(access: AccessContext, sourceId: string) {
  const batch = row<FeeBatch>(
    "SELECT * FROM accounting_fee_batches WHERE id=? AND organization_id=?",
    sourceId,
    access.organizationId,
  );
  if (!batch || batch.state !== "grouped" || batch.network !== "mainnet")
    throw new ApiError(
      409,
      "Choose an existing immutable mainnet NEAR fee group with independently verified source receipts",
      "NETSUITE_SOURCE_HELD",
    );
  const fees = rows<{
    id: string;
    evidence_hash: string;
    transaction_hash: string;
  }>(
    "SELECT f.id,f.evidence_hash,f.transaction_hash FROM accounting_fee_batch_items i JOIN accounting_fee_evidence f ON f.id=i.fee_id WHERE i.batch_id=? AND f.organization_id=? ORDER BY f.id",
    sourceId,
    access.organizationId,
  );
  if (!fees.length)
    throw new ApiError(
      409,
      "The original exact fee group is no longer intact",
      "NETSUITE_SOURCE_HELD",
    );
  return {
    id: batch.id,
    amountAtomic: batch.amount_atomic,
    asset: "NEAR",
    decimals: 24,
    network: batch.network,
    hash: digest({
      batchHash: batch.source_hash,
      fees,
      amount: batch.amount_atomic,
    }),
    transactionHashes: fees.map((item) => item.transaction_hash),
  };
}
async function verifyMapping(
  c: Connection,
  input: {
    subsidiaryId: string;
    currencyId: string;
    expenseAccountId: string;
    clearingAccountId: string;
  },
  accessToken: string,
) {
  const subsidiary = schemaObject(
      await request(
        c,
        `/subsidiary/${input.subsidiaryId}?expandSubResources=true`,
        accessToken,
      ),
    ),
    currency = schemaObject(
      await request(c, `/currency/${input.currencyId}`, accessToken),
    );
  const baseCurrency = schemaObject(subsidiary.currency),
    code =
      typeof currency.symbol === "string"
        ? currency.symbol
        : currency.currencyCode;
  if (
    String(subsidiary.id) !== input.subsidiaryId ||
    subsidiary.isInactive === true ||
    String(baseCurrency.id) !== input.currencyId ||
    String(currency.id) !== input.currencyId ||
    currency.isInactive === true ||
    typeof code !== "string" ||
    !["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "INR", "SGD"].includes(code)
  )
    throw new ApiError(
      409,
      "The selected subsidiary must expose an active, supported two-decimal base currency. No currency is inferred from a display symbol or an account name",
      "NETSUITE_CURRENCY_UNSUPPORTED",
    );
  const accounts = [];
  for (const [id, allowed] of [
    [input.expenseAccountId, ["Expense", "OthExpense"]],
    [input.clearingAccountId, ["OthCurrAsset", "OthAsset"]],
  ] as const) {
    const account = schemaObject(
        await request(c, `/account/${id}?expandSubResources=true`, accessToken),
      ),
      type = schemaObject(account.acctType),
      subsidiaries = schemaObject(account.subsidiary),
      items = Array.isArray(subsidiaries.items) ? subsidiaries.items : [];
    if (
      String(account.id) !== id ||
      account.isInactive === true ||
      account.isSummary === true ||
      !allowed.some((value) => value === String(type.id)) ||
      !items.some(
        (value) => String(schemaObject(value).id) === input.subsidiaryId,
      ) ||
      account.taxCode ||
      account.taxType ||
      account.isTaxAccount === true
    )
      throw new ApiError(
        409,
        "Use directly assigned active, non-summary expense and nonbank crypto-asset accounts without tax defaults. Inherited, tax, bank, control or unknown account types are unsupported",
        "NETSUITE_ACCOUNT_MAPPING_UNSUPPORTED",
      );
    if (
      account.currency &&
      String(schemaObject(account.currency).id) !== input.currencyId
    )
      throw new ApiError(
        409,
        "The selected journal account has another currency",
        "NETSUITE_CURRENCY_UNSUPPORTED",
      );
    accounts.push(account);
  }
  if (input.expenseAccountId === input.clearingAccountId)
    throw new ApiError(
      422,
      "Use distinct expense and nonbank crypto clearing accounts",
      "NETSUITE_ACCOUNT_MAPPING_UNSUPPORTED",
    );
  if (
    typeof (subsidiary.legalName ?? subsidiary.name) !== "string" ||
    !String(subsidiary.legalName ?? subsidiary.name).trim()
  )
    throw new ApiError(
      409,
      "The actual subsidiary record did not identify its legal entity",
      "NETSUITE_ENTITY_UNVERIFIED",
    );
  return {
    subsidiaryName: String(subsidiary.legalName ?? subsidiary.name ?? ""),
    currencyCode: code,
    accountsHash: digest({ subsidiary, currency, accounts }),
  };
}
export async function saveNetSuiteMapping(
  access: AccessContext,
  data: unknown,
) {
  const live = accountingAccess(access, true),
    c = connection(live),
    input = z
      .object({
        expectedVersion: z.number().int().nonnegative(),
        subsidiaryId: recordId,
        currencyId: recordId,
        expenseAccountId: recordId,
        clearingAccountId: recordId,
        legalEntityReference: z.string().trim().min(3).max(300),
        closedThrough: z.iso.date().nullable(),
        nonTaxJournalAcknowledged: z.literal(true),
      })
      .strict()
      .parse(data);
  if (
    input.expectedVersion !== c.mapping_version ||
    !c.catalog_at ||
    c.catalog_at < new Date(Date.now() - 86400000).toISOString() ||
    !c.catalog_ciphertext
  )
    throw new ApiError(
      409,
      "Refresh the actual live catalog and mapping before review",
      "NETSUITE_MAPPING_STALE",
    );
  const catalog = JSON.parse(decrypt(c.catalog_ciphertext)) as Catalog;
  journalSchema(catalog.schema);
  for (const [kind, id] of [
    ["subsidiary", input.subsidiaryId],
    ["currency", input.currencyId],
    ["account", input.expenseAccountId],
    ["account", input.clearingAccountId],
  ])
    if (!catalog.records.some((item) => item.kind === kind && item.id === id))
      throw new ApiError(
        409,
        "Select actual records from this account's imported catalogs",
        "NETSUITE_MAPPING_UNVERIFIED",
      );
  const accessToken = await token(c),
    schema = await currentSchema(c, accessToken);
  if (digest(schema) !== c.catalog_hash)
    throw new ApiError(
      409,
      "The live journal metadata changed during review. Refresh it first",
      "NETSUITE_SCHEMA_CHANGED",
    );
  const checked = await verifyMapping(c, input, accessToken),
    value: Mapping = {
      subsidiaryId: input.subsidiaryId,
      subsidiaryName: checked.subsidiaryName,
      currencyId: input.currencyId,
      currencyCode: checked.currencyCode,
      expenseAccountId: input.expenseAccountId,
      clearingAccountId: input.clearingAccountId,
      schemaHash: digest(schema),
      taxPolicy: "non_tax_journal_only",
      closedThrough: input.closedThrough,
      legalEntityReference: input.legalEntityReference,
      accountsHash: checked.accountsHash,
      reviewedBy: live.userId,
    };
  return transaction((db) => {
    accountingAccess(live, true);
    const current = fresh(c);
    if (current.mapping_version !== input.expectedVersion)
      throw new ApiError(
        409,
        "The NetSuite mapping changed during review",
        "NETSUITE_MAPPING_STALE",
      );
    const next = current.mapping_version + 1;
    db.prepare(
      "INSERT INTO netsuite_mapping_history(connection_id,version,payload_ciphertext,reviewed_by,created_at) VALUES(?,?,?,?,?)",
    ).run(c.id, next, encrypt(JSON.stringify(value)), live.userId, now());
    db.prepare(
      "UPDATE netsuite_connections SET mapping_ciphertext=?,mapping_version=?,updated_at=? WHERE id=? AND version=?",
    ).run(encrypt(JSON.stringify(value)), next, now(), c.id, c.version);
    db.prepare(
      "UPDATE netsuite_jobs SET state='held',last_error='MAPPING_CHANGED',updated_at=? WHERE connection_id=? AND state IN ('review','queued')",
    ).run(now(), c.id);
    audit(live.userId, live.organizationId, "netsuite.mapping_reviewed", c.id, {
      version: next,
    });
    return { mapping: value, version: next };
  });
}

interface Posting {
  reviewExpiresAt: string;
  accountDomain: string;
  mapping: Mapping;
  source: ReturnType<typeof source>;
  valuation: ReturnType<typeof valuedAsset>;
  payload: {
    externalId: string;
    tranDate: string;
    memo: string;
    subsidiary: { id: string };
    currency: { id: string };
    exchangeRate?: number;
    line: {
      items: Array<{
        account: { id: string };
        debit?: number;
        credit?: number;
        memo: string;
      }>;
    };
  };
  schemaHash: string;
  financialEffect: string;
}
function job(access: AccessContext, id: string) {
  const value = row<Job>(
    "SELECT * FROM netsuite_jobs WHERE id=? AND organization_id=?",
    id,
    access.organizationId,
  );
  if (!value)
    throw new ApiError(
      404,
      "NetSuite journal request not found",
      "NETSUITE_JOB_NOT_FOUND",
    );
  return value;
}
function requestCurrent(access: AccessContext, c: Connection, j: Job) {
  const current = fresh(c),
    value = mapping(current),
    posting = JSON.parse(decrypt(j.payload_ciphertext)) as Posting;
  if (
    current.status !== "active" ||
    current.version !== j.connection_version ||
    current.mapping_version !== j.mapping_version ||
    !value ||
    digest(value) !== digest(posting.mapping) ||
    source(access, j.source_id).hash !== j.source_hash
  )
    throw new ApiError(
      409,
      "Review the changed source, account, entity or mapping before posting",
      "NETSUITE_REVIEW_CHANGED",
    );
  if (posting.reviewExpiresAt <= now())
    throw new ApiError(
      409,
      "This exact review expired. Prepare and approve a fresh unattempted journal review",
      "NETSUITE_REVIEW_EXPIRED",
    );
  return posting;
}
export function previewNetSuiteJournal(access: AccessContext, data: unknown) {
  const live = accountingAccess(access),
    c = connection(live),
    value = mapping(c),
    input = z
      .object({
        sourceId: inputId,
        postingDate: z.iso.date(),
        valuation: valuationInput,
        nonTaxJournalAcknowledged: z.literal(true),
      })
      .strict()
      .parse(data);
  if (
    c.status !== "active" ||
    !value ||
    value.schemaHash !== c.catalog_hash ||
    !c.catalog_at ||
    c.catalog_at < new Date(Date.now() - 86400000).toISOString()
  )
    throw new ApiError(
      409,
      "Connect and review a fresh account schema and exact legal-entity mapping first",
      "NETSUITE_MAPPING_STALE",
    );
  if (
    input.postingDate > now().slice(0, 10) ||
    (value.closedThrough && input.postingDate <= value.closedThrough)
  )
    throw new ApiError(
      409,
      "The journal date is in the future or a reviewed closed period",
      "NETSUITE_PERIOD_CLOSED",
    );
  return transaction((db) => {
    const original = source(live, input.sourceId),
      fees = rows<{ id: string }>(
        "SELECT f.id FROM accounting_fee_batch_items i JOIN accounting_fee_evidence f ON f.id=i.fee_id WHERE i.batch_id=? AND f.organization_id=? ORDER BY f.id",
        original.id,
        live.organizationId,
      ),
      existing = row<Job>(
        "SELECT * FROM netsuite_jobs WHERE connection_id=? AND source_id=?",
        c.id,
        input.sourceId,
      );
    const expiredQueued =
      existing?.state === "queued" &&
      !existing.lease_owner &&
      (JSON.parse(decrypt(existing.payload_ciphertext)) as Posting)
        .reviewExpiresAt <= now();
    if (
      existing &&
      (existing.attempts ||
        (!["review", "held", "cancelled"].includes(existing.state) &&
          !expiredQueued))
    )
      throw new ApiError(
        409,
        "Inspect the existing original NetSuite journal. Attempted or uncertain writes cannot be replaced",
        "NETSUITE_WRITE_HELD",
      );
    const jobId = existing?.id ?? randomUUID(),
      externalId =
        existing?.external_id ?? `RZNS_${digest(jobId).slice(0, 24)}`;
    for (const fee of fees) {
      const used = row<{ job_id: string }>(
        "SELECT job_id FROM netsuite_fee_uses WHERE connection_id=? AND fee_id=?",
        c.id,
        fee.id,
      );
      if (used && used.job_id !== jobId)
        throw new ApiError(
          409,
          "An original fee is already reserved or exported through another NetSuite request. Regrouping cannot duplicate a posting",
          "NETSUITE_FEE_ALREADY_USED",
        );
    }
    const valuation = valuedAsset(original.amountAtomic, 24, input.valuation),
      catalog = JSON.parse(decrypt(c.catalog_ciphertext!)) as Catalog;
    journalSchema(catalog.schema);
    const root = schemaObject(schemaObject(catalog.schema).root),
      props = schemaObject(root.properties),
      memo =
        `Razor exact NEAR fee group ${original.id}; source ${original.hash}; ${valuation.valuation.numerator}/${valuation.valuation.denominator} ${value.currencyCode}/NEAR; ${valuation.valuation.date}; ${valuation.valuation.source}`.slice(
          0,
          900,
        ),
      payload: Posting["payload"] = {
        externalId,
        tranDate: input.postingDate,
        memo,
        subsidiary: { id: value.subsidiaryId },
        currency: { id: value.currencyId },
        ...(props.exchangeRate ? { exchangeRate: 1 } : {}),
        line: {
          items: [
            {
              account: { id: value.expenseAccountId },
              debit: valuation.value,
              memo: "Observed final NEAR token burn",
            },
            {
              account: { id: value.clearingAccountId },
              credit: valuation.value,
              memo: "Nonbank crypto asset clearing; no cash or bank-transfer claim",
            },
          ],
        },
      },
      posting: Posting = {
        reviewExpiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
        accountDomain: c.account_domain,
        mapping: value,
        source: original,
        valuation,
        payload,
        schemaHash: value.schemaHash,
        financialEffect:
          "Non-tax native-NEAR fee expense and nonbank crypto-clearing journal only. This does not approve an invoice, move funds, apply credit, reimburse a wallet or prove bank settlement. Provider journal approval workflows still apply.",
      },
      reviewHash = digest({
        jobId,
        connectionVersion: c.version,
        mappingVersion: c.mapping_version,
        posting,
      });
    if (!existing) reserveOptionalCreation(live, "accounting_plan", jobId);
    db.prepare(
      "INSERT INTO netsuite_jobs(id,organization_id,connection_id,connection_version,mapping_version,source_id,source_hash,external_id,payload_ciphertext,review_hash,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,source_id) DO UPDATE SET connection_version=excluded.connection_version,mapping_version=excluded.mapping_version,source_hash=excluded.source_hash,payload_ciphertext=excluded.payload_ciphertext,review_hash=excluded.review_hash,state='review',created_by=excluded.created_by,approved_by=NULL,approved_at=NULL,last_error=NULL,updated_at=excluded.updated_at",
    ).run(
      jobId,
      live.organizationId,
      c.id,
      c.version,
      c.mapping_version,
      original.id,
      original.hash,
      externalId,
      encrypt(JSON.stringify(posting)),
      reviewHash,
      live.userId,
      now(),
      now(),
    );
    for (const fee of fees)
      db.prepare(
        "INSERT INTO netsuite_fee_uses(connection_id,fee_id,job_id) VALUES(?,?,?) ON CONFLICT(connection_id,fee_id) DO NOTHING",
      ).run(c.id, fee.id, jobId);
    audit(
      live.userId,
      live.organizationId,
      "netsuite.journal_prepared",
      jobId,
      { sourceId: original.id },
    );
    return { id: jobId, reviewHash, posting };
  });
}
export function approveNetSuiteJournal(
  access: AccessContext,
  id: string,
  data: unknown,
) {
  const live = accountingAccess(access, true),
    input = z
      .object({
        reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
        disclosureAcknowledged: z.literal(true),
      })
      .strict()
      .parse(data);
  return transaction((db) => {
    const c = connection(live),
      j = job(live, id);
    if (
      j.state !== "review" ||
      j.review_hash !== input.reviewHash ||
      j.attempts
    )
      throw new ApiError(
        409,
        "Review this exact current unattempted journal before approval",
        "NETSUITE_REVIEW_CHANGED",
      );
    requestCurrent(live, c, j);
    db.prepare(
      "UPDATE netsuite_jobs SET state='queued',approved_by=?,approved_at=?,updated_at=? WHERE id=? AND state='review' AND attempts=0",
    ).run(live.userId, now(), now(), id);
    audit(live.userId, live.organizationId, "netsuite.journal_approved", id, {
      reviewHash: input.reviewHash,
    });
    return { queued: true };
  });
}
export function cancelNetSuiteReview(access: AccessContext, id: string) {
  const live = accountingAccess(access, true);
  return transaction((db) => {
    const j = job(live, id);
    if (j.attempts || j.approved_by || !["review", "held"].includes(j.state))
      throw new ApiError(
        409,
        "Only unapproved, unattempted NetSuite reviews can be retired and release their fee identities",
        "NETSUITE_WRITE_HELD",
      );
    db.prepare(
      "UPDATE netsuite_jobs SET state='cancelled',last_error='UNAPPROVED_REVIEW_RETIRED',updated_at=? WHERE id=? AND attempts=0 AND approved_by IS NULL",
    ).run(now(), id);
    db.prepare("DELETE FROM netsuite_fee_uses WHERE job_id=?").run(id);
    audit(live.userId, live.organizationId, "netsuite.review_retired", id);
    return { cancelled: true };
  });
}
async function lookup(c: Connection, j: Job, accessToken: string) {
  const response = await transportFor(c.account_domain)({
    url:
      apiBase(c.account_domain) +
      `/journalentry/eid:${encodeURIComponent(j.external_id)}?expandSubResources=true`,
    method: "GET",
    headers: headers(accessToken),
  });
  if (response.status === 404) return null;
  if (response.status !== 200)
    throw new ApiError(
      502,
      "NetSuite could not confirm the original external ID. Its outcome stays held",
      "NETSUITE_RECONCILIATION_UNAVAILABLE",
    );
  return schemaObject(response.body);
}
function exactResult(j: Job, body: Record<string, unknown>) {
  const p = JSON.parse(decrypt(j.payload_ciphertext)) as Posting,
    lines = schemaObject(body.line),
    items = lines.items;
  if (
    !recordId.safeParse(String(body.id)).success ||
    String(body.externalId) !== j.external_id ||
    body.tranDate !== p.payload.tranDate ||
    String(schemaObject(body.subsidiary).id) !== p.payload.subsidiary.id ||
    String(schemaObject(body.currency).id) !== p.payload.currency.id ||
    (p.payload.exchangeRate !== undefined && body.exchangeRate !== 1) ||
    !Array.isArray(items) ||
    items.length !== 2 ||
    body.taxDetailsOverride ||
    (typeof body.taxTotal === "number" && body.taxTotal !== 0)
  )
    return false;
  return (
    items.every((item, index) => {
      const value = schemaObject(item),
        expected = p.payload.line.items[index];
      return (
        String(schemaObject(value.account).id) === expected.account.id &&
        (value.debit ?? 0) === (expected.debit ?? 0) &&
        (value.credit ?? 0) === (expected.credit ?? 0) &&
        value.memo === expected.memo &&
        !value.taxCode &&
        !value.taxType &&
        (value.taxAmount ?? 0) === 0
      );
    }) && body.memo === p.payload.memo
  );
}
function attach(
  access: AccessContext,
  c: Connection,
  held: Job,
  body: Record<string, unknown>,
  acknowledge: boolean,
  workerLease?: string,
) {
  const matches = exactResult(held, body),
    fingerprint = digest(body);
  return transaction((db) => {
    accountingAccess(access, acknowledge);
    const current = row<Job>(
      "SELECT * FROM netsuite_jobs WHERE id=? AND organization_id=?",
      held.id,
      access.organizationId,
    )!;
    fresh(c);
    if (
      current.review_hash !== held.review_hash ||
      current.provider_hash !== held.provider_hash ||
      current.attempts !== held.attempts + (workerLease ? 1 : 0) ||
      (workerLease
        ? current.lease_owner !== workerLease || current.state !== "dispatching"
        : current.state !== held.state ||
          current.lease_owner !== held.lease_owner)
    )
      throw new ApiError(
        409,
        "The journal changed during its provider observation. Refresh without retrying the write",
        "NETSUITE_OBSERVATION_STALE",
      );
    const sameIdentity =
      !current.provider_id || current.provider_id === String(body.id);
    const state =
      matches &&
      sameIdentity &&
      (!current.provider_hash ||
        current.provider_hash === fingerprint ||
        acknowledge)
        ? "done"
        : "held";
    db.prepare(
      "UPDATE netsuite_jobs SET state=?,provider_id=?,provider_hash=?,observed_ciphertext=?,lease_owner=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND review_hash=?",
    ).run(
      state,
      current.provider_id ?? String(body.id ?? ""),
      state === "done" ? fingerprint : current.provider_hash,
      encrypt(JSON.stringify(body)),
      state === "done"
        ? null
        : !sameIdentity
          ? "EXTERNAL_RECORD_ID_CHANGED"
          : matches
            ? "EXTERNAL_REVISION_REVIEW_REQUIRED"
            : "EXTERNAL_FINANCIAL_CONFLICT",
      now(),
      held.id,
      held.review_hash,
    );
    return {
      matched: state === "done",
      state,
      providerId: String(body.id ?? ""),
      account: c.account_domain,
    };
  });
}
export async function reconcileNetSuiteJournal(
  access: AccessContext,
  id: string,
  data: unknown,
) {
  const input = z
      .object({
        acknowledgeMatchingRevision: z.boolean().default(false),
        expectedProviderHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .parse(data),
    live = accountingAccess(access, input.acknowledgeMatchingRevision),
    c = connection(live),
    j = job(live, id);
  if (!["done", "unknown", "held"].includes(j.state))
    throw new ApiError(
      409,
      "Wait for this request's active processing or review state before reconciliation",
      "NETSUITE_REQUEST_BUSY",
    );
  const posting = JSON.parse(decrypt(j.payload_ciphertext)) as Posting;
  if (c.account_domain !== posting.accountDomain)
    throw new ApiError(
      409,
      "Reconnect the original NetSuite account for read-only recovery",
      "NETSUITE_ACCOUNT_FIXED",
    );
  const body = await lookup(c, j, await token(c));
  accountingAccess(live, input.acknowledgeMatchingRevision);
  fresh(c);
  if (!body) {
    transaction((db) => {
      const current = job(live, id);
      if (
        current.review_hash !== j.review_hash ||
        current.attempts !== j.attempts ||
        current.state !== j.state
      )
        throw new ApiError(
          409,
          "The request changed during lookup",
          "NETSUITE_OBSERVATION_STALE",
        );
      db.prepare(
        "UPDATE netsuite_jobs SET state=?,last_error='NO_PROVIDER_MATCH_YET',updated_at=? WHERE id=?",
      ).run(j.attempts ? "unknown" : "held", now(), id);
    });
    return {
      matched: false,
      state: j.attempts ? "unknown" : "held",
      note: "Absence of a record does not prove that no write occurred. Attempted requests are never automatically replayed.",
    };
  }
  if (
    input.acknowledgeMatchingRevision &&
    (!input.expectedProviderHash || digest(body) !== input.expectedProviderHash)
  )
    throw new ApiError(
      409,
      "Inspect the exact latest provider revision before acknowledging it",
      "NETSUITE_OBSERVATION_STALE",
    );
  return attach(live, c, j, body, input.acknowledgeMatchingRevision);
}
export async function dispatchNetSuiteJobs(
  options: { organizationId?: string; maxJobs?: number } = {},
) {
  const results: Array<{ id: string; state: string }> = [];
  for (
    let index = 0;
    index < Math.min(3, Math.max(1, options.maxJobs ?? 1));
    index++
  ) {
    const held = transaction((db) => {
      db.prepare(
        "UPDATE netsuite_jobs SET state='unknown',last_error='WRITE_OUTCOME_UNCONFIRMED',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE state='dispatching' AND lease_until<=?",
      ).run(now(), now());
      db.prepare(
        "UPDATE netsuite_jobs SET state='queued',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE state='preflight' AND attempts=0 AND lease_until<=?",
      ).run(now(), now());
      const j = row<Job>(
        "SELECT * FROM netsuite_jobs j WHERE j.state='queued' AND j.attempts=0 AND (? IS NULL OR j.organization_id=?) AND NOT EXISTS(SELECT 1 FROM netsuite_jobs x WHERE x.connection_id=j.connection_id AND x.state IN ('preflight','dispatching') AND x.lease_until>?) ORDER BY j.created_at,j.id LIMIT 1",
        options.organizationId ?? null,
        options.organizationId ?? null,
        now(),
      );
      if (!j) return null;
      const lease = randomUUID();
      db.prepare(
        "UPDATE netsuite_jobs SET state='preflight',lease_owner=?,lease_until=?,updated_at=? WHERE id=? AND state='queued' AND attempts=0",
      ).run(lease, new Date(Date.now() + 180000).toISOString(), now(), j.id);
      return { ...j, lease_owner: lease };
    });
    if (!held) break;
    let started = false;
    try {
      const live = accountingAccess({
        userId: held.created_by,
        organizationId: held.organization_id,
        permissions: [],
      });
      if (!held.approved_by)
        throw new ApiError(
          409,
          "A fresh exact journal approval is required",
          "NETSUITE_APPROVAL_REQUIRED",
        );
      accountingAccess(
        {
          userId: held.approved_by,
          organizationId: held.organization_id,
          permissions: [],
        },
        true,
      );
      const c = connection(live),
        posting = requestCurrent(live, c, held),
        accessToken = await token(c),
        previous = await lookup(c, held, accessToken);
      if (previous) {
        const current = {
          ...held,
          state: "preflight",
          attempts: held.attempts,
        };
        const result = attach(live, c, current, previous, false);
        results.push({ id: held.id, state: result.state });
        continue;
      }
      const schema = await currentSchema(c, accessToken);
      if (digest(schema) !== posting.schemaHash)
        throw new ApiError(
          409,
          "The live journal schema changed",
          "NETSUITE_SCHEMA_CHANGED",
        );
      const accounts = await verifyMapping(c, posting.mapping, accessToken);
      if (accounts.accountsHash !== posting.mapping.accountsHash)
        throw new ApiError(
          409,
          "The mapped legal entity, base currency or accounts changed",
          "NETSUITE_MAPPING_STALE",
        );
      transaction((db) => {
        accountingAccess(live);
        accountingAccess(
          {
            userId: held.approved_by!,
            organizationId: held.organization_id,
            permissions: [],
          },
          true,
        );
        requestCurrent(live, c, held);
        const changed = db
          .prepare(
            "UPDATE netsuite_jobs SET state='dispatching',attempts=1,write_started_at=?,updated_at=? WHERE id=? AND state='preflight' AND attempts=0 AND lease_owner=? AND lease_until>?",
          )
          .run(now(), now(), held.id, held.lease_owner, now());
        if (!changed.changes)
          throw new ApiError(
            409,
            "The journal worker fence expired",
            "NETSUITE_REQUEST_BUSY",
          );
      });
      started = true;
      const response = await transportFor(c.account_domain)({
        url: apiBase(c.account_domain) + "/journalentry",
        method: "POST",
        headers: headers(accessToken, {
          "X-NetSuite-PropertyNameValidation": "Error",
          "X-NetSuite-PropertyValueValidation": "Error",
        }),
        body: canonical(posting.payload),
      });
      if (response.status < 200 || response.status >= 300)
        throw new ApiError(
          502,
          "The original journal write was not confirmed. Reconcile its immutable external ID before any further action",
          "NETSUITE_WRITE_UNCONFIRMED",
        );
      const observed = await lookup(c, held, accessToken);
      if (!observed)
        throw new ApiError(
          502,
          "The original external ID is not yet readable",
          "NETSUITE_WRITE_UNCONFIRMED",
        );
      const result = attach(live, c, held, observed, false, held.lease_owner!);
      results.push({ id: held.id, state: result.state });
    } catch (error) {
      const state = started ? "unknown" : "held",
        code =
          error instanceof ApiError
            ? error.code
            : started
              ? "WRITE_OUTCOME_UNCONFIRMED"
              : "PREFLIGHT_UNAVAILABLE";
      const changed = getDb()
        .prepare(
          "UPDATE netsuite_jobs SET state=?,last_error=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_owner=?",
        )
        .run(state, code, now(), held.id, held.lease_owner);
      results.push({
        id: held.id,
        state: changed.changes
          ? state
          : (row<{ state: string }>(
              "SELECT state FROM netsuite_jobs WHERE id=?",
              held.id,
            )?.state ?? state),
      });
    }
  }
  return { processed: results.length, jobs: results };
}
export async function disconnectNetSuite(access: AccessContext) {
  const live = accountingAccess(access),
    c = connection(live),
    stored = c.token_ciphertext
      ? (JSON.parse(decrypt(c.token_ciphertext)) as { refreshToken: string })
      : null;
  transaction((db) => {
    db.prepare(
      "UPDATE netsuite_connections SET status='disabled',token_ciphertext=NULL,expires_at=NULL,version=version+1,refresh_owner=NULL,refresh_until=NULL,updated_at=? WHERE id=?",
    ).run(now(), c.id);
    db.prepare(
      "UPDATE netsuite_oauth_states SET consumed_at=? WHERE connection_id=? AND consumed_at IS NULL",
    ).run(now(), c.id);
    db.prepare(
      "UPDATE netsuite_jobs SET state='held',last_error='CONNECTION_DISABLED',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE connection_id=? AND state IN ('review','queued','preflight')",
    ).run(now(), c.id);
    audit(live.userId, live.organizationId, "netsuite.disconnected", c.id);
  });
  let providerRevoked = false;
  try {
    if (stored) {
      const response = await transportFor(c.account_domain)({
        url: authEndpoint(c.account_domain, "revoke"),
        method: "POST",
        headers: {
          authorization: basicAuth(),
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({ token: stored.refreshToken }).toString(),
      });
      providerRevoked = response.status >= 200 && response.status < 300;
    }
  } catch {
    providerRevoked = false;
  }
  return {
    stoppedLocally: true,
    providerRevoked,
    note: providerRevoked
      ? "NetSuite grant revocation confirmed. Previously sent journal writes may still complete."
      : "Saved access was removed and future work stopped. Revoke the grant in NetSuite if provider revocation is unconfirmed. Previously sent journals still need read-only reconciliation.",
  };
}
export function netSuiteOverview(access: AccessContext, page = 1) {
  const live = accountingAccess(access),
    c = row<Connection>(
      "SELECT * FROM netsuite_connections WHERE organization_id=?",
      live.organizationId,
    ),
    bounded = Math.max(1, Math.min(100000, page));
  return {
    configured: settings().configured,
    redirectUri: settings().redirectUri,
    connection: c ? safe(c) : null,
    jobs: rows<Job>(
      "SELECT * FROM netsuite_jobs WHERE organization_id=? ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET ?",
      live.organizationId,
      (bounded - 1) * 25,
    ).map(({ payload_ciphertext, observed_ciphertext, ...value }) => ({
      ...value,
      posting: JSON.parse(decrypt(payload_ciphertext)) as Posting,
      observation: observed_ciphertext
        ? {
            record: JSON.parse(decrypt(observed_ciphertext)) as Record<
              string,
              unknown
            >,
            hash: digest(JSON.parse(decrypt(observed_ciphertext))),
          }
        : null,
    })),
    feeGroups: rows<FeeBatch>(
      "SELECT * FROM accounting_fee_batches WHERE organization_id=? AND state='grouped' ORDER BY created_at DESC LIMIT 100",
      live.organizationId,
    ),
    page: bounded,
    hasMore: !!row(
      "SELECT id FROM netsuite_jobs WHERE organization_id=? LIMIT 1 OFFSET ?",
      live.organizationId,
      bounded * 25,
    ),
    scope:
      "One company-bound NetSuite account, OneWorld subsidiary base currency, explicit non-tax two-line journal for an existing verified mainnet NEAR fee group. No bills, credit notes, payroll rows, bank feeds, transfers, taxes, arbitrary custom fields, FX execution, automatic approvals or funding claims. Required/custom/tax schemas outside this subset stay held. Posting is available only after account-specific metadata and every mapped record are verified live.",
  };
}
