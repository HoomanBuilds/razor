import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../context";
import { requireFreshSession } from "../identity/session";
import {
  createEvidenceShare,
  deleteEvidenceShare,
  listEvidenceShares,
  readPublicEvidenceShare,
  revokeEvidenceShare,
} from "./service";

export const evidenceShareRoutes = new Hono<AppEnv>();
evidenceShareRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});
evidenceShareRoutes.use(
  "*",
  bodyLimit({
    maxSize: 4096,
    onError: (c) =>
      c.json(
        {
          error:
            "Choose a retained source and disclosure settings. Evidence uploads are not accepted",
          code: "EVIDENCE_SHARE_INPUT_TOO_LARGE",
        },
        413,
      ),
  }),
);
evidenceShareRoutes.get("/", (c) =>
  c.json(listEvidenceShares(c.get("access"), c.req.query())),
);
evidenceShareRoutes.post("/", async (c) => {
  const session = requireFreshSession(c);
  const result = createEvidenceShare(
    c.get("access"),
    await c.req.json(),
    session,
  );
  return c.json(result, result.created ? 201 : 200);
});
evidenceShareRoutes.post("/:id/revoke", async (c) =>
  c.json(
    revokeEvidenceShare(c.get("access"), c.req.param("id"), await c.req.json()),
  ),
);
evidenceShareRoutes.delete("/:id", async (c) =>
  c.json(
    deleteEvidenceShare(c.get("access"), c.req.param("id"), await c.req.json()),
  ),
);
export const publicEvidenceShareRoutes = new Hono<AppEnv>();
publicEvidenceShareRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store, private, max-age=0");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  c.header("X-Content-Type-Options", "nosniff");
  await next();
});
publicEvidenceShareRoutes.get("/:token", (c) =>
  c.json(readPublicEvidenceShare(c.req.param("token"))),
);
publicEvidenceShareRoutes.get("/:token/packet", (c) => {
  const value = readPublicEvidenceShare(c.req.param("token"));
  c.header(
    "Content-Disposition",
    'attachment; filename="razor-shared-evidence-v1.json"',
  );
  return c.json(value.packet);
});
export { purgeEvidenceShares } from "./service";
