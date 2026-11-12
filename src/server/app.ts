import { Hono } from "hono";
import { ZodError } from "zod";
import { ApiError, type AppEnv } from "./context";
import { identityRoutes, requireOrganization, requireUser } from "./identity";
import { assetRoutes, paymentsRoutes } from "./payments";
import { businessRoutes } from "./business/routes";
import { assistantRoutes } from "./assistant";
import { onboardingRoutes } from "./treasury-onboarding";

export const app = new Hono<AppEnv>().basePath("/api");
app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: error.message, code: error.code }, error.status as 400);
  if (error instanceof ZodError) return c.json({ error: "Check the submitted fields", code: "VALIDATION_ERROR", fields: error.flatten() }, 400);
  if (error instanceof SyntaxError) return c.json({ error: "Submit valid JSON", code: "INVALID_JSON" }, 400);
  console.error("Request failed", { name: error.name, message: error.message });
  return c.json({ error: "The request could not be completed", code: "INTERNAL_ERROR" }, 500);
});
app.get("/health", (c) => c.json({ service: "float", status: "ok" }));
app.route("/", identityRoutes);
app.use("/assets", requireUser);
app.use("/assets/*", requireUser);
app.route("/assets", assetRoutes);
app.use("/organizations/:orgId/*", requireUser, requireOrganization("company:read"));
app.route("/organizations/:orgId", paymentsRoutes);
app.route("/organizations/:orgId", businessRoutes);
app.route("/organizations/:orgId/assistant", assistantRoutes);
app.route("/organizations/:orgId/onboarding", onboardingRoutes);
app.notFound((c) => c.json({ error: "Endpoint not found", code: "NOT_FOUND" }, 404));
