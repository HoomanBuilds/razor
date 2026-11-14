import { Hono } from "hono";
import type { AppEnv } from "../context";
import { publicDemoInput, getPublicDemoScenario } from "./scenario";
import { publicDemoIdentity } from "./identity";
export { getPublicDemoScenario, publicDemoInput } from "./scenario";
export { publicDemoIdentity } from "./identity";
export type { PublicDemoBuildIdentity, PublicDemoIdentity } from "./identity";
export type { PublicDemoScenario, PublicDemoSelection } from "./scenario";
export const demoRoutes = new Hono<AppEnv>();
demoRoutes.get("/scenario", (c) => {
  const parsed = publicDemoInput.safeParse(c.req.query());
  if (!parsed.success)
    return c.json(
      {
        error:
          "Choose a fixed payments/clearing scenario and supported hypothetical branch",
        code: "DEMO_INPUT_INVALID",
      },
      400,
    );
  c.header("Cache-Control", "no-store");
  return c.json({
    scenario: getPublicDemoScenario(parsed.data),
    identity: publicDemoIdentity(),
  });
});
