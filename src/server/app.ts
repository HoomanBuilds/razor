import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import { ApiError, type AppEnv } from "./context";
import { identityRoutes, requireOrganization, requireUser } from "./identity";
import { assetRoutes, paymentsRoutes } from "./payments";
import { businessRoutes } from "./business/routes";
import { assistantRoutes } from "./assistant";
import { onboardingRoutes } from "./treasury-onboarding";
import { operationsRoutes } from "./operations";
import { reconciliationRoutes } from "./reconciliation";
import {
  companyInvoiceIntakeRoutes,
  recipientWorkspaceRoutes,
} from "./recipient-workspace";
import { treasuryPolicyRoutes } from "./treasury-policy";
import { fundingRequestRoutes, publicFundingRoutes, sourceFundingRoutes } from "./funding-requests";
import { paymentManagementRoutes } from "./payment-management";
import { financeRoutes } from "./assistant/finance";
import { clientReserveRoutes } from "./client-reserves";
import { notificationRoutes } from "./notifications";
import { projectRoutes } from "./projects";
import { accountRecoveryRoutes, treasuryRecoveryRoutes } from "./account-recovery";
import { retainedAssetRoutes } from "./retained-assets";
import { clearingRoutes } from "./clearing";
import { paymentFundingRoutes } from "./payment-funding";
import { fundingRefundRoutes } from "./funding-refunds";
import { partialSettlementRoutes } from "./partial-settlement";
import { billingRoutes } from "./billing";

export const app = new Hono<AppEnv>().basePath("/api");
app.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  await next();
});
app.use(
  "*",
  bodyLimit({
    maxSize: 1_048_576,
    onError: (c) =>
      c.json(
        {
          error: "Submit a request smaller than 1 MB",
          code: "REQUEST_TOO_LARGE",
        },
        413,
      ),
  }),
);
app.onError((error, c) => {
  if (error instanceof ApiError)
    return c.json(
      { error: error.message, code: error.code },
      error.status as 400,
    );
  if (/^(CLEARING_LOCKED|CLEARED_LIABILITY|PARTIAL_LIABILITY):/.test(error.message)) {
    const separator = error.message.indexOf(":");
    return c.json({ error: error.message.slice(separator + 1).trim(), code: error.message.slice(0, separator) }, 409);
  }
  if (error instanceof ZodError)
    return c.json(
      {
        error: "Check the submitted fields",
        code: "VALIDATION_ERROR",
        fields: error.flatten(),
      },
      400,
    );
  if (error instanceof SyntaxError)
    return c.json({ error: "Submit valid JSON", code: "INVALID_JSON" }, 400);
  console.error("Request failed", { name: error.name, message: error.message });
  return c.json(
    { error: "The request could not be completed", code: "INTERNAL_ERROR" },
    500,
  );
});
app.get("/health", (c) => c.json({ service: "razor", status: "ok" }));
app.route("/", identityRoutes);
app.use("/assets", requireUser);
app.use("/assets/*", requireUser);
app.route("/assets", assetRoutes);
app.route("/recipient-workspace", recipientWorkspaceRoutes);
app.route("/notifications", notificationRoutes);
app.route("/account", accountRecoveryRoutes);
app.route("/funding-requests", publicFundingRoutes);
app.use(
  "/organizations/:orgId/*",
  requireUser,
  requireOrganization("company:read"),
);
app.route("/organizations/:orgId", paymentsRoutes);
app.route("/organizations/:orgId", businessRoutes);
app.route("/organizations/:orgId/assistant", assistantRoutes);
app.route("/organizations/:orgId/onboarding", onboardingRoutes);
app.route("/organizations/:orgId/operations", operationsRoutes);
app.route("/organizations/:orgId/reconciliation", reconciliationRoutes);
app.route("/organizations/:orgId/intake", companyInvoiceIntakeRoutes);
app.route("/organizations/:orgId/treasury-policy", treasuryPolicyRoutes);
app.route("/organizations/:orgId/funding-requests", fundingRequestRoutes);
app.route("/organizations/:orgId/source-funding", sourceFundingRoutes);
app.route("/organizations/:orgId/payment-management", paymentManagementRoutes);
app.route("/organizations/:orgId/assistant/finance", financeRoutes);
app.route("/organizations/:orgId/client-reserves", clientReserveRoutes);
app.route("/organizations/:orgId/projects", projectRoutes);
app.route("/organizations/:orgId/access-recovery", treasuryRecoveryRoutes);
app.route("/organizations/:orgId/retained-assets", retainedAssetRoutes);
app.route("/organizations/:orgId/clearing", clearingRoutes);
app.route("/organizations/:orgId/payment-funding", paymentFundingRoutes);
app.route("/organizations/:orgId/funding-refunds", fundingRefundRoutes);
app.route("/organizations/:orgId/partial-settlements", partialSettlementRoutes);
app.route("/organizations/:orgId/billing", billingRoutes);
app.notFound((c) =>
  c.json({ error: "Endpoint not found", code: "NOT_FOUND" }, 404),
);
