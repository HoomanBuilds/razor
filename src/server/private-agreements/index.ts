import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireUser } from "../identity/session";
import * as service from "./service";

const selectedVersion = (value?: string) =>
  value === undefined
    ? undefined
    : z.coerce.number().int().min(1).max(20).parse(value);
const kind = z.enum(["offer", "negotiation"]);
export const companyPrivateAgreementRoutes = new Hono<AppEnv>();
companyPrivateAgreementRoutes.use("*", bodyLimit({ maxSize: 180000 }));
companyPrivateAgreementRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
companyPrivateAgreementRoutes.get("/", (c) =>
  c.json(service.companyOverview(c.get("access"))),
);
companyPrivateAgreementRoutes.post("/", async (c) =>
  c.json(
    { tender: service.createTender(c.get("access"), await c.req.json()) },
    201,
  ),
);
companyPrivateAgreementRoutes.get("/tenders/:id", (c) =>
  c.json({
    tender: service.companyDetail(
      c.get("access"),
      c.req.param("id"),
      selectedVersion(c.req.query("version")),
    ),
  }),
);
companyPrivateAgreementRoutes.post("/tenders/:id/revisions", async (c) =>
  c.json(
    {
      tender: service.reviseTender(
        c.get("access"),
        c.req.param("id"),
        await c.req.json(),
      ),
    },
    201,
  ),
);
for (const action of ["publish", "reveal", "close"] as const)
  companyPrivateAgreementRoutes.post(`/tenders/:id/${action}`, async (c) =>
    c.json({
      tender: service.tenderAction(
        c.get("access"),
        c.req.param("id"),
        action,
        await c.req.json(),
      ),
    }),
  );
companyPrivateAgreementRoutes.post("/tenders/:id/mandates", async (c) =>
  c.json(
    {
      tender: service.proposeMandate(
        c.get("access"),
        c.req.param("id"),
        await c.req.json(),
      ),
    },
    201,
  ),
);
companyPrivateAgreementRoutes.post("/mandates/:id/decision", async (c) =>
  c.json({
    tender: service.decideMandate(
      c.get("access"),
      c.req.param("id"),
      await c.req.json(),
    ),
  }),
);
companyPrivateAgreementRoutes.post("/mandates/:id/rounds", async (c) =>
  c.json(
    {
      tender: service.submitNegotiation(
        c.get("access"),
        c.req.param("id"),
        await c.req.json(),
      ),
    },
    201,
  ),
);
companyPrivateAgreementRoutes.get("/sealed/:kind/:id", (c) =>
  c.json(
    service.downloadSealed(
      c.get("access"),
      kind.parse(c.req.param("kind")),
      c.req.param("id"),
    ),
  ),
);
companyPrivateAgreementRoutes.post("/sealed/:kind/:id/delete", async (c) =>
  c.json({
    tender: service.deleteEncryptedContent(
      c.get("access"),
      kind.parse(c.req.param("kind")),
      c.req.param("id"),
      await c.req.json(),
    ),
  }),
);
companyPrivateAgreementRoutes.post("/tenders/:id/final", async (c) =>
  c.json(
    {
      tender: service.discloseFinal(
        c.get("access"),
        c.req.param("id"),
        await c.req.json(),
      ),
    },
    201,
  ),
);
companyPrivateAgreementRoutes.post("/agreements/:id/decision", async (c) =>
  c.json({
    tender: service.decideAgreement(
      c.get("access"),
      c.req.param("id"),
      await c.req.json(),
    ),
  }),
);
companyPrivateAgreementRoutes.post("/agreements/:id/purchase", async (c) =>
  c.json(
    {
      tender: service.createAgreementPurchase(
        c.get("access"),
        c.req.param("id"),
        await c.req.json(),
      ),
    },
    201,
  ),
);

export const supplierPrivateAgreementRoutes = new Hono<AppEnv>();
supplierPrivateAgreementRoutes.use(
  "*",
  requireUser,
  bodyLimit({ maxSize: 180000 }),
);
supplierPrivateAgreementRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
supplierPrivateAgreementRoutes.get("/", (c) =>
  c.json(service.supplierOverview(c.get("userId"))),
);
supplierPrivateAgreementRoutes.get("/tenders/:id", (c) =>
  c.json({
    tender: service.supplierDetail(
      c.get("userId"),
      c.req.param("id"),
      selectedVersion(c.req.query("version")),
    ),
  }),
);
supplierPrivateAgreementRoutes.post("/invitations/:id/offers", async (c) =>
  c.json(
    {
      tender: service.submitOffer(
        c.get("userId"),
        c.req.param("id"),
        await c.req.json(),
      ),
    },
    201,
  ),
);
supplierPrivateAgreementRoutes.post("/invitations/:id/withdraw", async (c) =>
  c.json({
    tender: service.withdrawOffer(
      c.get("userId"),
      c.req.param("id"),
      await c.req.json(),
    ),
  }),
);
supplierPrivateAgreementRoutes.post("/mandates/:id/rounds", async (c) =>
  c.json(
    {
      tender: service.submitNegotiation(
        c.get("userId"),
        c.req.param("id"),
        await c.req.json(),
      ),
    },
    201,
  ),
);
supplierPrivateAgreementRoutes.get("/sealed/:kind/:id", (c) =>
  c.json(
    service.downloadSealed(
      c.get("userId"),
      kind.parse(c.req.param("kind")),
      c.req.param("id"),
    ),
  ),
);
supplierPrivateAgreementRoutes.post("/sealed/:kind/:id/delete", async (c) =>
  c.json({
    tender: service.deleteEncryptedContent(
      c.get("userId"),
      kind.parse(c.req.param("kind")),
      c.req.param("id"),
      await c.req.json(),
    ),
  }),
);
supplierPrivateAgreementRoutes.post("/agreements/:id/decision", async (c) =>
  c.json({
    tender: service.decideAgreement(
      c.get("userId"),
      c.req.param("id"),
      await c.req.json(),
    ),
  }),
);
