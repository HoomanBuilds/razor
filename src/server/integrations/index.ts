import { Hono } from "hono";
import { z } from "zod";
import { ApiError, type AppEnv } from "../context";
import { appOrigin } from "../identity/session";
import { handleIntegrationMcp } from "./mcp";
import { authenticateIntegration, acquireIntegrationRequest, createIntegrationCredential, createIntegrationDraft, integrationAuditPage, integrationEvidence, integrationFinancialStatus, integrationPaymentAttempts, integrationRequestStatus, integrationResource, integrationResourcePage, integrationSettings, revokeIntegrationCredential, rotateIntegrationCredential, type IntegrationPrincipal } from "./service";
import { createWebhookEndpoint, inspectWebhookDelivery, replayWebhookDelivery, rotateWebhookSecret, setWebhookEnabled, webhookSettings } from "./webhooks";
import { credentialInput, draftSchemas, integrationOutputSchemas, integrationScopes, pageInput } from "./schemas";

export { dispatchIntegrationWebhooks, enqueueIntegrationEvent } from "./webhooks";
export const integrationManagementRoutes = new Hono<AppEnv>();
integrationManagementRoutes.get("/", c => c.json(integrationSettings(c.get("access"))));
integrationManagementRoutes.post("/credentials", async c => c.json(createIntegrationCredential(c.get("access"), await c.req.json()), 201));
integrationManagementRoutes.delete("/credentials/:id", c => c.json(revokeIntegrationCredential(c.get("access"), c.req.param("id"))));
integrationManagementRoutes.post("/credentials/:id/rotate", c => c.json(rotateIntegrationCredential(c.get("access"), c.req.param("id"))));
integrationManagementRoutes.get("/requests", c => c.json(integrationAuditPage(c.get("access"), c.req.query())));
integrationManagementRoutes.get("/webhooks", c => c.json(webhookSettings(c.get("access"), c.req.query())));
integrationManagementRoutes.post("/webhooks", async c => c.json(await createWebhookEndpoint(c.get("access"), await c.req.json()), 201));
integrationManagementRoutes.patch("/webhooks/:id", async c => c.json(setWebhookEnabled(c.get("access"), c.req.param("id"), z.strictObject({ enabled: z.boolean() }).parse(await c.req.json()).enabled)));
integrationManagementRoutes.post("/webhooks/:id/rotate", c => c.json(rotateWebhookSecret(c.get("access"), c.req.param("id"))));
integrationManagementRoutes.get("/deliveries/:id", c => c.json(inspectWebhookDelivery(c.get("access"), c.req.param("id"))));
integrationManagementRoutes.post("/deliveries/:id/replay", c => c.json(replayWebhookDelivery(c.get("access"), c.req.param("id"))));

type MachineEnv = { Variables: { principal: IntegrationPrincipal } };
export const integrationMachineRoutes = new Hono<MachineEnv>();
integrationMachineRoutes.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  if (origin && origin !== appOrigin()) throw new ApiError(403, "Request origin is not allowed", "ORIGIN_REJECTED");
  const principal = authenticateIntegration(c.req.header("authorization"));
  const release = acquireIntegrationRequest(principal);
  c.set("principal", principal);
  c.header("Razor-API-Version", "1");
  try { await next(); } finally { release(); }
});
integrationMachineRoutes.all("/mcp", c => handleIntegrationMcp(c.req.raw, c.get("principal")));
integrationMachineRoutes.get("/v1/schema", c => c.json({ version: "1", scopes: integrationScopes, executionEnabled: false,
  inputs: { credential: z.toJSONSchema(credentialInput, { io: "input" }), page: z.toJSONSchema(pageInput, { io: "input" }), paymentDraft: z.toJSONSchema(draftSchemas.payment), invoiceDraft: z.toJSONSchema(draftSchemas.invoice), recipientDraft: z.toJSONSchema(draftSchemas.recipient) },
  outputs: Object.fromEntries(Object.entries(integrationOutputSchemas).map(([name, schema]) => [name, z.toJSONSchema(schema)])),
  endpoints: [
    ...[["payments", "payment"], ["invoices", "invoice"], ["recipients", "recipient"]].flatMap(([plural, kind]) => [
      { method: "GET", path: `/${plural}`, scope: `${plural}:read`, query: "page", response: `${kind}Page` },
      { method: "GET", path: `/${plural}/{id}`, scope: `${plural}:read`, response: kind, wrapper: kind },
      { method: "POST", path: `/${plural}/drafts`, scope: `${plural}:draft`, input: `${kind}Draft`, response: "draftReceipt", status: 201, idempotencyRequired: true },
    ]),
    { method: "GET", path: "/requests/{id}", scope: "corresponding draft scope", response: "requestStatus" },
    { method: "GET", path: "/payments/{id}/attempts", scope: "payments:read", response: "attempts" },
    { method: "GET", path: "/attempts/{id}/evidence", scope: "evidence:read", response: "evidence" },
    { method: "GET", path: "/funding/{id}", scope: "funding:read", response: "funding", wrapper: "funding" },
    { method: "GET", path: "/payroll/{id}", scope: "payroll:read", response: "payroll", wrapper: "payroll" },
  ],
  idempotency: { header: "Idempotency-Key", pattern: "^[A-Za-z0-9._:-]{8,128}$", binding: ["organization", "credential", "kind", "validated immutable terms"], conflictCode: "IDEMPOTENCY_CONFLICT" },
  pagination: { order: "createdAt DESC, id DESC", cursor: "after", next: "nextCursor", max: 100 },
  limits: { requestsPerMinute: 60, concurrentRequests: 4, paymentAtomicMaximum: "340282366920938463463374607431768211455", invoiceAtomicMaximum: "1000000000000000000000000000000", requestBytes: 1048576 },
  errors: { "400": ["VALIDATION_ERROR", "INVALID_JSON"], "401": ["INVALID_CREDENTIAL"], "403": ["INSUFFICIENT_SCOPE", "FORBIDDEN", "COMPANY_ACCESS_DENIED", "ORIGIN_REJECTED"], "404": ["NOT_FOUND", "PAYMENT_NOT_FOUND", "RECIPIENT_NOT_FOUND"], "409": ["IDEMPOTENCY_CONFLICT", "DUPLICATE_INVOICE"], "422": ["INVALID_CURSOR", "INVALID_AMOUNT", "INVALID_DESTINATION"], "429": ["RATE_LIMITED"], "503": ["ENCRYPTION_SETUP_REQUIRED"] },
}));
for (const [plural, kind] of [["payments", "payment"], ["invoices", "invoice"], ["recipients", "recipient"]] as const) {
  integrationMachineRoutes.get(`/v1/${plural}`, c => c.json(integrationResourcePage(c.get("principal"), kind, c.req.query())));
  integrationMachineRoutes.get(`/v1/${plural}/:id`, c => c.json({ [kind]: integrationResource(c.get("principal"), kind, c.req.param("id")) }));
  integrationMachineRoutes.post(`/v1/${plural}/drafts`, async c => c.json(createIntegrationDraft(c.get("principal"), kind, c.req.header("idempotency-key") ?? "", await c.req.json()), 201));
}
integrationMachineRoutes.get("/v1/requests/:id", c => c.json(integrationRequestStatus(c.get("principal"), c.req.param("id"))));
integrationMachineRoutes.get("/v1/attempts/:id/evidence", c => c.json(integrationEvidence(c.get("principal"), c.req.param("id"))));
integrationMachineRoutes.get("/v1/payments/:id/attempts", c => c.json(integrationPaymentAttempts(c.get("principal"), c.req.param("id"))));
for (const kind of ["funding", "payroll"] as const) integrationMachineRoutes.get(`/v1/${kind}/:id`, c => c.json({ [kind]: integrationFinancialStatus(c.get("principal"), kind, c.req.param("id")) }));
