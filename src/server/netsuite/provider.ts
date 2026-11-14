import { z } from "zod";
import { ApiError } from "../context";
import { appOrigin } from "../identity/session";
import type {
  AccountingTransport,
  TransportRequest,
} from "../accounting/providers";

export const recordId = z.string().regex(/^[1-9]\d{0,19}$/);
export function accountDomain(input: string) {
  const domain = input.trim().toLowerCase().replaceAll("_", "-");
  if (!/^[a-z0-9]{3,40}(?:-(?:sb|rp)[1-9]\d{0,5})?$/.test(domain))
    throw new ApiError(
      422,
      "Enter the NetSuite account ID, including its explicit sandbox suffix when applicable. URLs and custom hosts are unsupported",
      "NETSUITE_ACCOUNT_INVALID",
    );
  return domain;
}
export function settings() {
  return {
    configured:
      !!process.env.NETSUITE_CLIENT_ID && !!process.env.NETSUITE_CLIENT_SECRET,
    clientId: process.env.NETSUITE_CLIENT_ID ?? "",
    redirectUri: `${appOrigin()}/api/netsuite-oauth/callback`,
  };
}
export function basicAuth() {
  const config = settings();
  if (!config.configured)
    throw new ApiError(
      503,
      "Configure NETSUITE_CLIENT_ID and NETSUITE_CLIENT_SECRET for the confidential integration",
      "NETSUITE_SETUP_REQUIRED",
    );
  return `Basic ${Buffer.from(`${config.clientId}:${process.env.NETSUITE_CLIENT_SECRET}`).toString("base64url")}`;
}
export function apiBase(domain: string) {
  return `https://${accountDomain(domain)}.suitetalk.api.netsuite.com/services/rest/record/v1`;
}
export function authEndpoint(domain: string, action: "token" | "revoke") {
  return `https://${accountDomain(domain)}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/${action}`;
}
export function headers(token: string, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "content-type": "application/json",
    ...extra,
  };
}
export function transportFor(domain: string): AccountingTransport {
  const host = `${accountDomain(domain)}.suitetalk.api.netsuite.com`;
  return async (input: TransportRequest) => {
    const url = new URL(input.url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== host ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith("/services/rest/")
    )
      throw new ApiError(
        422,
        "The request must remain on this verified account-specific NetSuite HTTPS host",
        "NETSUITE_DESTINATION_INVALID",
      );
    const response = await fetch(url, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      }),
      reader = response.body?.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (reader)
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 2_000_000)
            throw new ApiError(
              502,
              "The NetSuite response exceeded its bounded import limit",
              "NETSUITE_RESPONSE_LIMIT",
            );
          chunks.push(chunk.value);
        }
    } finally {
      await reader?.cancel().catch(() => {});
    }
    let body: unknown = null;
    if (size) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new ApiError(
          502,
          "NetSuite returned an unsupported non-JSON response",
          "NETSUITE_RESPONSE_INVALID",
        );
      }
    }
    return {
      status: response.status,
      body,
      headers: {
        location: response.headers.get("location") ?? "",
        "retry-after": response.headers.get("retry-after") ?? "",
      },
    };
  };
}
export function tokenResponse(input: unknown, previousRefresh?: string) {
  const value = z
    .object({
      access_token: z.string().min(1).max(16384),
      refresh_token: z.string().min(1).max(16384).optional(),
      expires_in: z.number().int().min(30).max(86400),
      token_type: z.string(),
    })
    .parse(input);
  if (
    value.token_type.toLowerCase() !== "bearer" ||
    (!value.refresh_token && !previousRefresh)
  )
    throw new ApiError(
      502,
      "NetSuite did not return a supported rotating bearer grant",
      "NETSUITE_AUTH_INVALID",
    );
  return {
    tokens: {
      accessToken: value.access_token,
      refreshToken: value.refresh_token ?? previousRefresh!,
    },
    expiresAt: new Date(Date.now() + value.expires_in * 1000).toISOString(),
  };
}
export interface CatalogRecord {
  id: string;
  name: string;
  kind: "subsidiary" | "account" | "currency" | "tax";
}
export function catalogPage(input: unknown, kind: CatalogRecord["kind"]) {
  const value = z
    .object({
      items: z
        .array(
          z
            .object({
              id: z.union([recordId, z.number().int().positive()]),
              refName: z.string().max(300).optional(),
            })
            .passthrough(),
        )
        .max(100),
      hasMore: z.boolean().optional(),
    })
    .parse(input);
  return {
    records: value.items.map((item) => ({
      id: String(item.id),
      name: item.refName ?? `${kind} ${item.id}`,
      kind,
    })),
    hasMore: value.hasMore ?? value.items.length === 100,
  };
}

type Schema = Record<string, unknown>;
export function schemaObject(input: unknown): Schema {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ApiError(
      409,
      "NetSuite metadata is not a supported object schema",
      "NETSUITE_SCHEMA_UNSUPPORTED",
    );
  return input as Schema;
}
function resolve(node: unknown, document: Schema): Schema {
  const value = schemaObject(node);
  if (value.$ref) {
    if (typeof value.$ref !== "string" || !value.$ref.startsWith("#/"))
      throw new ApiError(
        409,
        "This NetSuite schema requires an unresolved external field definition. No write is available",
        "NETSUITE_SCHEMA_UNSUPPORTED",
      );
    let resolved: unknown = document;
    for (const part of value.$ref.slice(2).split("/"))
      resolved =
        schemaObject(resolved)[
          part.replaceAll("~1", "/").replaceAll("~0", "~")
        ];
    return schemaObject(resolved);
  }
  return value;
}
function editableRequired(node: Schema, allowed: string[]) {
  if (node.allOf || node.oneOf || node.anyOf)
    throw new ApiError(
      409,
      "Conditional/custom NetSuite journal requirements are unsupported",
      "NETSUITE_SCHEMA_UNSUPPORTED",
    );
  const props = schemaObject(node.properties),
    required = Array.isArray(node.required) ? [...node.required] : [];
  for (const [name, property] of Object.entries(props)) {
    const value = schemaObject(property);
    if (value.required === true || value["x-ns-mandatory"] === true)
      required.push(name);
  }
  for (const name of required) {
    if (
      typeof name === "string" &&
      props[name] &&
      schemaObject(props[name]).readOnly === true
    )
      continue;
    if (typeof name !== "string" || !allowed.includes(name))
      throw new ApiError(
        409,
        `The NetSuite journal requires an unmapped field: ${String(name).slice(0, 80)}`,
        "NETSUITE_REQUIRED_FIELD_UNSUPPORTED",
      );
  }
  return props;
}
export function journalSchema(input: unknown) {
  const snapshot = schemaObject(input),
    document = schemaObject(snapshot.root ?? input),
    root = resolve(document, document),
    properties = editableRequired(root, [
      "externalId",
      "tranDate",
      "memo",
      "subsidiary",
      "currency",
      "exchangeRate",
      "line",
    ]);
  for (const name of [
    "externalId",
    "tranDate",
    "memo",
    "subsidiary",
    "currency",
    "line",
  ])
    if (!properties[name] || schemaObject(properties[name]).readOnly === true)
      throw new ApiError(
        409,
        `The account does not expose writable ${name} journal metadata`,
        "NETSUITE_SCHEMA_UNSUPPORTED",
      );
  if (
    properties.exchangeRate &&
    schemaObject(properties.exchangeRate).readOnly === true
  )
    throw new ApiError(
      409,
      "A read-only exchange-rate schema cannot accept the explicit base-currency journal rate",
      "NETSUITE_SCHEMA_UNSUPPORTED",
    );
  const element = snapshot.lineElement
      ? schemaObject(snapshot.lineElement)
      : resolve(
          resolve(
            schemaObject(resolve(properties.line, document).properties).items,
            document,
          ).items,
          document,
        ),
    fields = editableRequired(element, ["account", "debit", "credit", "memo"]);
  if (snapshot.lineCollection)
    editableRequired(schemaObject(snapshot.lineCollection), ["items"]);
  if (snapshot.lineItems) {
    const items = schemaObject(snapshot.lineItems);
    if (
      (typeof items.minItems === "number" && items.minItems > 2) ||
      (typeof items.maxItems === "number" && items.maxItems < 2)
    )
      throw new ApiError(
        409,
        "This journal schema does not accept the supported exact two-line structure",
        "NETSUITE_SCHEMA_UNSUPPORTED",
      );
  }
  if (
    Array.isArray(element.required) &&
    element.required.some((value) => value === "debit" || value === "credit")
  )
    throw new ApiError(
      409,
      "This journal schema requires a fixed debit or credit on every line and is outside the supported balanced pair",
      "NETSUITE_SCHEMA_UNSUPPORTED",
    );
  for (const name of ["account", "debit", "credit", "memo"])
    if (!fields[name] || schemaObject(fields[name]).readOnly === true)
      throw new ApiError(
        409,
        "The account's journal lines cannot be mapped exactly",
        "NETSUITE_SCHEMA_UNSUPPORTED",
      );
  return {
    supported: true as const,
    required: Array.isArray(root.required) ? root.required : [],
    taxPolicy: "non_tax_journal_only" as const,
  };
}
