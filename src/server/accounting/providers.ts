import { z } from "zod";
import { ApiError } from "../context";
import { appOrigin } from "../identity/session";
import type {
  CatalogItem,
  Connection,
  Entity,
  Provider,
  PostingKind,
} from "./model";

export interface TransportRequest {
  url: string;
  method: "GET" | "POST" | "DELETE";
  headers: Record<string, string>;
  body?: string;
}
export interface TransportResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}
export type AccountingTransport = (
  request: TransportRequest,
) => Promise<TransportResponse>;
const hosts = new Set([
  "oauth.platform.intuit.com",
  "developer.api.intuit.com",
  "quickbooks.api.intuit.com",
  "sandbox-quickbooks.api.intuit.com",
  "identity.xero.com",
  "api.xero.com",
]);
export const accountingTransport: AccountingTransport = async (input) => {
  const url = new URL(input.url);
  if (
    url.protocol !== "https:" ||
    !hosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    throw new ApiError(
      422,
      "Unsupported accounting provider destination",
      "ACCOUNTING_DESTINATION_INVALID",
    );
  const response = await fetch(url, {
    method: input.method,
    headers: input.headers,
    body: input.body,
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
  });
  if (
    response.headers.get("content-length") &&
    Number(response.headers.get("content-length")) > 2_000_000
  )
    throw new Error("ACCOUNTING_RESPONSE_LIMIT");
  const reader = response.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader)
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 2_000_000) throw new Error("ACCOUNTING_RESPONSE_LIMIT");
        chunks.push(chunk.value);
      }
  } finally {
    await reader?.cancel().catch(() => {});
  }
  let body: unknown = null;
  try {
    if (size) body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("ACCOUNTING_RESPONSE_INVALID");
  }
  return {
    status: response.status,
    body,
    headers: { "retry-after": response.headers.get("retry-after") ?? "" },
  };
};
export function providerConfig(provider: Provider) {
  const prefix = provider === "quickbooks" ? "QUICKBOOKS" : "XERO",
    clientId = process.env[`${prefix}_CLIENT_ID`] ?? "",
    clientSecret = process.env[`${prefix}_CLIENT_SECRET`] ?? "";
  const environment =
    provider === "quickbooks"
      ? (process.env.QUICKBOOKS_ENVIRONMENT ?? "sandbox")
      : "tenant";
  const configured =
    !!clientId &&
    !!clientSecret &&
    (provider !== "quickbooks" ||
      ["sandbox", "production"].includes(environment));
  return {
    provider,
    clientId,
    clientSecret,
    environment,
    configured,
    redirectUri: `${appOrigin()}/api/accounting-oauth/${provider}/callback`,
    authorize:
      provider === "quickbooks"
        ? "https://appcenter.intuit.com/connect/oauth2"
        : "https://login.xero.com/identity/connect/authorize",
    token:
      provider === "quickbooks"
        ? "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
        : "https://identity.xero.com/connect/token",
    scopes:
      provider === "quickbooks"
        ? "com.intuit.quickbooks.accounting"
        : "offline_access accounting.invoices accounting.payments accounting.manualjournals accounting.contacts.read accounting.settings.read",
  };
}
export function basicAuthentication(provider: Provider) {
  const config = providerConfig(provider);
  if (!config.configured)
    throw new ApiError(
      503,
      "The accounting provider needs operator client configuration",
      "ACCOUNTING_SETUP_REQUIRED",
    );
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
}
export interface Tokens {
  accessToken: string;
  refreshToken: string;
}
export function parseTokens(value: unknown) {
  const parsed = z
    .object({
      access_token: z.string().min(1).max(8192),
      refresh_token: z.string().min(1).max(8192),
      expires_in: z.number().int().min(30).max(86400),
      token_type: z.string().optional(),
    })
    .parse(value);
  if (parsed.token_type && parsed.token_type.toLowerCase() !== "bearer")
    throw new ApiError(
      502,
      "Unsupported provider token type",
      "ACCOUNTING_AUTH_INVALID",
    );
  return {
    tokens: {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
    },
    expiresAt: new Date(Date.now() + parsed.expires_in * 1000).toISOString(),
  };
}
export function apiBase(connection: Connection) {
  if (connection.provider === "xero") return "https://api.xero.com/api.xro/2.0";
  if (!connection.entity_id || !/^\d{1,30}$/.test(connection.entity_id))
    throw new ApiError(
      409,
      "Select the verified QuickBooks company",
      "ACCOUNTING_ENTITY_REQUIRED",
    );
  return `https://${connection.environment === "production" ? "quickbooks.api.intuit.com" : "sandbox-quickbooks.api.intuit.com"}/v3/company/${connection.entity_id}`;
}
export function apiHeaders(connection: Connection, accessToken: string) {
  return {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    "content-type": "application/json",
    ...(connection.provider === "xero"
      ? { "xero-tenant-id": connection.entity_id! }
      : {}),
  };
}
export function recordName(provider: Provider, kind: PostingKind) {
  return provider === "quickbooks"
    ? (
        {
          bill: "Bill",
          settlement: "BillPayment",
          credit: "VendorCredit",
          fee: "JournalEntry",
          fx: "JournalEntry",
        } as const
      )[kind]
    : (
        {
          bill: "Invoices",
          settlement: "Payments",
          credit: "CreditNotes",
          fee: "ManualJournals",
          fx: "ManualJournals",
        } as const
      )[kind];
}
export function markerField(provider: Provider, kind: PostingKind) {
  return provider === "quickbooks"
    ? "DocNumber"
    : (
        {
          bill: "InvoiceNumber",
          settlement: "Reference",
          credit: "CreditNoteNumber",
          fee: "Narration",
          fx: "Narration",
        } as const
      )[kind];
}
export function externalObject(
  provider: Provider,
  kind: PostingKind,
  body: unknown,
) {
  const value = body as Record<string, unknown>;
  const name = recordName(provider, kind);
  const data =
    provider === "quickbooks"
      ? value?.[name]
      : Array.isArray(value?.[name])
        ? (value[name] as unknown[])[0]
        : null;
  if (!data || typeof data !== "object")
    throw new ApiError(
      502,
      "The provider did not return the expected accounting record",
      "ACCOUNTING_RESPONSE_INVALID",
    );
  const item = data as Record<string, unknown>,
    id =
      item[
        provider === "quickbooks"
          ? "Id"
          : (
              {
                bill: "InvoiceID",
                settlement: "PaymentID",
                credit: "CreditNoteID",
                fee: "ManualJournalID",
                fx: "ManualJournalID",
              } as const
            )[kind]
      ];
  if (typeof id !== "string" || !id || item.HasErrors)
    throw new ApiError(
      502,
      "The provider record needs review",
      "ACCOUNTING_RESPONSE_INVALID",
    );
  return {
    id,
    revision: String(item.SyncToken ?? item.UpdatedDateUTC ?? ""),
    item,
  };
}
export function collection(provider: Provider, kind: PostingKind) {
  const name = recordName(provider, kind);
  return provider === "quickbooks" ? name.toLowerCase() : name;
}
export async function providerEntities(
  provider: Provider,
  token: string,
  realmId: string | undefined,
  transport: AccountingTransport,
): Promise<Entity[]> {
  if (provider === "quickbooks") {
    if (!realmId || !/^\d{1,30}$/.test(realmId))
      throw new ApiError(
        422,
        "QuickBooks did not identify a valid company",
        "ACCOUNTING_ENTITY_REQUIRED",
      );
    const config = providerConfig(provider),
      base =
        config.environment === "production"
          ? "quickbooks.api.intuit.com"
          : "sandbox-quickbooks.api.intuit.com";
    const result = await transport({
      url: `https://${base}/v3/company/${realmId}/companyinfo/${realmId}`,
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    const data = result.body as {
      CompanyInfo?: { Id?: string; CompanyName?: string; LegalName?: string };
    };
    if (
      result.status !== 200 ||
      !data.CompanyInfo?.Id ||
      !data.CompanyInfo.CompanyName
    )
      throw new ApiError(
        403,
        "This grant does not verify that QuickBooks company",
        "ACCOUNTING_ENTITY_INVALID",
      );
    return [
      {
        id: realmId,
        name: data.CompanyInfo.LegalName || data.CompanyInfo.CompanyName,
      },
    ];
  }
  const result = await transport({
    url: "https://api.xero.com/connections",
    method: "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  const data = z
    .array(
      z.object({
        id: z.string().uuid(),
        tenantId: z.string().uuid(),
        tenantName: z.string().min(1).max(300),
        tenantType: z.string().optional(),
      }),
    )
    .max(100)
    .safeParse(result.body);
  if (result.status !== 200 || !data.success)
    throw new ApiError(
      403,
      "This grant does not verify connected Xero organisations",
      "ACCOUNTING_ENTITY_INVALID",
    );
  return data.data
    .filter((item) => !item.tenantType || item.tenantType === "ORGANISATION")
    .map((item) => ({
      id: item.tenantId,
      name: item.tenantName,
      connectionId: item.id,
    }));
}
export function catalogItems(
  provider: Provider,
  kind: CatalogItem["kind"],
  body: unknown,
): CatalogItem[] {
  const value = body as Record<string, unknown>,
    key =
      provider === "quickbooks"
        ? kind === "account"
          ? "Account"
          : kind === "tax"
            ? "TaxCode"
            : "Vendor"
        : kind === "account"
          ? "Accounts"
          : kind === "tax"
            ? "TaxRates"
            : "Contacts";
  const nested =
    provider === "quickbooks"
      ? (value?.QueryResponse as Record<string, unknown>)?.[key]
      : value?.[key];
  if (nested === undefined) return [];
  if (!Array.isArray(nested) || nested.length > 1000)
    throw new ApiError(
      502,
      "The provider catalog response is unsupported",
      "ACCOUNTING_RESPONSE_INVALID",
    );
  return nested.map((item) => {
    if (!item || typeof item !== "object")
      throw new ApiError(
        502,
        "The provider catalog item is incomplete",
        "ACCOUNTING_RESPONSE_INVALID",
      );
    const id =
      provider === "quickbooks"
        ? item.Id
        : kind === "account"
          ? item.AccountID
          : kind === "tax"
            ? item.TaxType
            : item.ContactID;
    const name = item.Name ?? item.DisplayName;
    if (
      typeof id !== "string" ||
      !id ||
      typeof name !== "string" ||
      id.length > 128 ||
      name.length > 300
    )
      throw new ApiError(
        502,
        "The provider catalog item is incomplete",
        "ACCOUNTING_RESPONSE_INVALID",
      );
    return {
      id,
      name,
      kind,
      type: item.AccountType ?? item.Type,
      code: item.Code,
      currency: item.CurrencyRef?.value ?? item.CurrencyCode,
      systemAccount:
        typeof item.SystemAccount === "string" ? item.SystemAccount : undefined,
      zeroTax:
        kind === "tax"
          ? provider === "quickbooks"
            ? item.Taxable === false
            : item.EffectiveRate === 0
          : undefined,
      active:
        item.Active !== false &&
        item.Status !== "ARCHIVED" &&
        item.ContactStatus !== "ARCHIVED",
    };
  });
}
