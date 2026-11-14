import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z, ZodError } from "zod";
import { ApiError } from "../context";
import { draftSchemas, idempotencyInput, pageInput } from "./schemas";
import { createIntegrationDraft, integrationEvidence, integrationFinancialStatus, integrationPaymentAttempts, integrationRequestStatus, integrationResource, integrationResourcePage, type IntegrationPrincipal } from "./service";

function toolResult(action: () => unknown) {
  try {
    const output = action();
    return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
  } catch (error) {
    const code = error instanceof ApiError ? error.code : error instanceof ZodError ? "VALIDATION_ERROR" : "INTERNAL_ERROR";
    const message = error instanceof ApiError ? error.message : error instanceof ZodError ? "Check the tool arguments" : "The request could not be completed";
    return { content: [{ type: "text" as const, text: JSON.stringify({ code, error: message }) }], isError: true };
  }
}

export function createIntegrationMcpServer(principal: IntegrationPrincipal) {
  const server = new McpServer({ name: "razor-company-integrations", version: "1.0.0" }, { capabilities: { tools: { listChanged: false } } });
  for (const kind of ["payment", "invoice", "recipient"] as const) {
    server.registerTool(`request_${kind}_draft`, {
      description: `Create a company ${kind} draft. Requires ${kind === "invoice" ? "invoices" : `${kind}s`}:draft. No approval, execution or receiving-profile mutation. Reuse the same idempotency key only for identical terms.`,
      inputSchema: z.strictObject({ idempotencyKey: idempotencyInput, draft: draftSchemas[kind] }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, input => toolResult(() => createIntegrationDraft(principal, kind, input.idempotencyKey, input.draft)));
    server.registerTool(`get_${kind}`, {
      description: `Read a scoped company ${kind}. Requires ${kind === "invoice" ? "invoices" : `${kind}s`}:read.`,
      inputSchema: z.strictObject({ id: z.string().min(1).max(128) }),
      annotations: { readOnlyHint: true },
    }, ({ id }) => toolResult(() => integrationResource(principal, kind, id)));
    server.registerTool(`list_${kind}s`, {
      description: `List company ${kind} records using the returned nextCursor as after.`, inputSchema: pageInput,
      annotations: { readOnlyHint: true },
    }, query => toolResult(() => integrationResourcePage(principal, kind, query)));
  }
  server.registerTool("get_request_status", {
    description: "Read this credential's draft request status. Requires the corresponding draft permission and current member permissions.",
    inputSchema: z.strictObject({ requestId: z.string().min(1).max(128) }), annotations: { readOnlyHint: true },
  }, ({ requestId }) => toolResult(() => integrationRequestStatus(principal, requestId)));
  server.registerTool("get_settlement_evidence", {
    description: "Read company-scoped retained settlement evidence. Requires evidence:read. Expired receipts remain unavailable.",
    inputSchema: z.strictObject({ attemptId: z.string().min(1).max(128) }), annotations: { readOnlyHint: true },
  }, ({ attemptId }) => toolResult(() => integrationEvidence(principal, attemptId)));
  server.registerTool("get_payment_attempts", {
    description: "Read company payment attempt IDs and states for evidence lookup. Requires payments:read. Receiving addresses and provider secrets are omitted.",
    inputSchema: z.strictObject({ paymentId: z.string().min(1).max(128) }), annotations: { readOnlyHint: true },
  }, ({ paymentId }) => toolResult(() => integrationPaymentAttempts(principal, paymentId)));
  for (const kind of ["funding", "payroll"] as const) server.registerTool(`get_${kind}_status`, {
    description: `Read a company ${kind} status. Requires ${kind}:read. Provider processing never implies company credit or recipient delivery.`,
    inputSchema: z.strictObject({ id: z.string().min(1).max(128) }), annotations: { readOnlyHint: true },
  }, ({ id }) => toolResult(() => integrationFinancialStatus(principal, kind, id)));
  return server;
}

export function handleIntegrationMcp(request: Request, principal: IntegrationPrincipal) {
  if (request.method !== "POST") return Response.json({ error: "Use POST for MCP tool requests", code: "METHOD_NOT_ALLOWED" }, { status: 405, headers: { Allow: "POST" } });
  const handler = createMcpHandler(() => createIntegrationMcpServer(principal), { legacy: "stateless", maxSubscriptions: 0, keepAliveMs: 0 });
  return handler.fetch(request);
}
