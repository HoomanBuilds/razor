import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { ApiError, type AppEnv } from "../context";
import { appOrigin, currentSession } from "../identity/session";
import { newToken } from "../identity/crypto";
import { accountingAccess } from "../accounting/service";
import * as service from "./service";

const cookieName = () =>
    `${appOrigin().startsWith("https:") ? "__Host-" : ""}razor_netsuite_oauth`,
  cookieOptions = () => ({
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: appOrigin().startsWith("https:"),
    path: "/",
    maxAge: 600,
  });
export const netsuiteRoutes = new Hono<AppEnv>();
netsuiteRoutes.use("*", bodyLimit({ maxSize: 20000 }));
netsuiteRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
netsuiteRoutes.get("/", (c) =>
  c.json(
    service.netSuiteOverview(
      c.get("access"),
      z.coerce
        .number()
        .int()
        .min(1)
        .max(100000)
        .default(1)
        .parse(c.req.query("page")),
    ),
  ),
);
netsuiteRoutes.post("/connect", async (c) => {
  const session = currentSession(c),
    access = c.get("access");
  if (!session || session.user_id !== access.userId)
    throw new ApiError(
      401,
      "Sign in to this company before connecting NetSuite",
      "UNAUTHENTICATED",
    );
  const nonce = newToken(),
    result = service.beginNetSuite(
      access,
      await c.req.json(),
      nonce,
      session.id,
    );
  setCookie(c, cookieName(), nonce, cookieOptions());
  return c.json(result);
});
netsuiteRoutes.post("/disconnect", (c) =>
  service.disconnectNetSuite(c.get("access")).then((result) => c.json(result)),
);
netsuiteRoutes.post("/catalog", async (c) =>
  c.json(
    await service.refreshNetSuiteCatalog(c.get("access"), await c.req.json()),
  ),
);
netsuiteRoutes.put("/mapping", async (c) =>
  c.json(
    await service.saveNetSuiteMapping(c.get("access"), await c.req.json()),
  ),
);
netsuiteRoutes.post("/journals", async (c) =>
  c.json(
    service.previewNetSuiteJournal(c.get("access"), await c.req.json()),
    201,
  ),
);
netsuiteRoutes.post("/journals/:id/approve", async (c) =>
  c.json(
    service.approveNetSuiteJournal(
      c.get("access"),
      c.req.param("id"),
      await c.req.json(),
    ),
  ),
);
netsuiteRoutes.post("/journals/:id/cancel", (c) =>
  c.json(service.cancelNetSuiteReview(c.get("access"), c.req.param("id"))),
);
netsuiteRoutes.post("/journals/:id/reconcile", async (c) =>
  c.json(
    await service.reconcileNetSuiteJournal(
      c.get("access"),
      c.req.param("id"),
      await c.req.json(),
    ),
  ),
);
netsuiteRoutes.post("/dispatch", async (c) => {
  const live = accountingAccess(c.get("access"), true);
  return c.json(
    await service.dispatchNetSuiteJobs({
      organizationId: live.organizationId,
      maxJobs: 1,
    }),
  );
});

export const netsuiteOAuthRoutes = new Hono<AppEnv>();
netsuiteOAuthRoutes.get("/callback", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const result = await service.finishNetSuite(
      c.req.query(),
      getCookie(c, cookieName()),
    );
    deleteCookie(c, cookieName(), cookieOptions());
    const url = new URL(appOrigin());
    url.search = new URLSearchParams({
      company: result.organizationId,
      section: "accounting",
    }).toString();
    return c.redirect(url.toString(), 303);
  } catch (error) {
    deleteCookie(c, cookieName(), cookieOptions());
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      502,
      "NetSuite consent could not complete. Start a fresh company request without sharing tokens",
      "NETSUITE_AUTH_FAILED",
    );
  }
});
export { dispatchNetSuiteJobs } from "./service";
