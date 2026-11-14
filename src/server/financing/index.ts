import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../context";
import { requireUser } from "../identity/session";
import * as service from "./service";
const router = () => {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
  });
  app.use("*", bodyLimit({ maxSize: 16384 }));
  return app;
};
export const financingRoutes = router();
financingRoutes.get("/", (c) =>
  c.json(service.listCompanyFinancing(c.get("access"), c.req.query())),
);
financingRoutes.post("/", async (c) =>
  c.json(
    {
      request: service.createFinancingRequest(
        c.get("access"),
        await c.req.json(),
      ),
    },
    201,
  ),
);
financingRoutes.get("/:id", (c) =>
  c.json({
    request: service.inspectCompanyFinancing(
      c.get("access"),
      c.req.param("id"),
    ),
  }),
);
financingRoutes.delete("/:id", (c) =>
  c.json(
    service.cancelOpenFinancingRequest(c.get("access"), c.req.param("id")),
  ),
);
financingRoutes.post("/:id/accept", async (c) =>
  c.json({
    request: await service.acceptFinancingOffer(
      c.get("access"),
      c.req.param("id"),
      await c.req.json(),
    ),
  }),
);
financingRoutes.post("/:id/action", async (c) =>
  c.json(
    await service.prepareFinancingAction(
      c.get("userId"),
      c.req.param("id"),
      await c.req.json(),
      c.get("access"),
    ),
  ),
);
financingRoutes.post("/:id/begin", async (c) =>
  c.json(
    service.beginFinancingAction(
      c.get("userId"),
      c.req.param("id"),
      await c.req.json(),
      c.get("access"),
    ),
  ),
);
financingRoutes.post("/:id/reconcile", async (c) =>
  c.json({
    request: await service.reconcileFinancing(
      c.get("userId"),
      c.req.param("id"),
      c.get("access"),
    ),
  }),
);
financingRoutes.post("/:id/advance-evidence", async (c) =>
  c.json(
    await service.financingAdvanceEvidence(
      c.get("access"),
      c.req.param("id"),
      await c.req.json(),
    ),
  ),
);
export const lenderFinancingRoutes = router();
lenderFinancingRoutes.use("*", requireUser);
lenderFinancingRoutes.get("/market", (c) =>
  c.json(service.marketFinancing(c.get("userId"), c.req.query())),
);
lenderFinancingRoutes.get("/loans", (c) =>
  c.json(service.ownFinancing(c.get("userId"), c.req.query())),
);
lenderFinancingRoutes.get("/:id", (c) =>
  c.json({
    request: service.inspectPersonalFinancing(
      c.get("userId"),
      c.req.param("id"),
    ),
  }),
);
lenderFinancingRoutes.post("/:id/offers", async (c) =>
  c.json(
    {
      offer: service.submitFinancingOffer(
        c.get("userId"),
        c.req.param("id"),
        await c.req.json(),
      ),
    },
    201,
  ),
);
lenderFinancingRoutes.post("/:id/offers/:offerId/withdraw", (c) =>
  c.json(
    service.withdrawFinancingOffer(
      c.get("userId"),
      c.req.param("id"),
      c.req.param("offerId"),
    ),
  ),
);
lenderFinancingRoutes.post("/:id/action", async (c) =>
  c.json(
    await service.prepareFinancingAction(
      c.get("userId"),
      c.req.param("id"),
      await c.req.json(),
    ),
  ),
);
lenderFinancingRoutes.post("/:id/begin", async (c) =>
  c.json(
    service.beginFinancingAction(
      c.get("userId"),
      c.req.param("id"),
      await c.req.json(),
    ),
  ),
);
lenderFinancingRoutes.post("/:id/reconcile", async (c) =>
  c.json({
    request: await service.reconcileFinancing(
      c.get("userId"),
      c.req.param("id"),
    ),
  }),
);
