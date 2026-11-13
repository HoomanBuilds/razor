import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireUser } from "../identity/session";
import { listRecipientNotices, notificationPreferences, readRecipientNotice, saveNotificationPreferences } from "./service";

export const notificationRoutes = new Hono<AppEnv>();
notificationRoutes.use("*", requireUser);
notificationRoutes.get("/", c => c.json({ notices: listRecipientNotices(c.get("userId")), preferences: notificationPreferences(c.get("userId")) }));
notificationRoutes.post("/:id/read", c => c.json(readRecipientNotice(c.get("userId"), c.req.param("id"))));
notificationRoutes.put("/preferences", async c => c.json(saveNotificationPreferences(c.get("userId"), z.object({ emailEnabled: z.boolean() }).parse(await c.req.json()).emailEnabled)));
