import { Hono } from "hono";
import type { AppEnv } from "../context";
import { authRoutes } from "./auth";
import { organizationRoutes, invitationRoutes } from "./organizations";
import { recipientRoutes, recipientPortalRoutes } from "./recipients";

export const identityRoutes = new Hono<AppEnv>();
identityRoutes.route("/auth",authRoutes);
identityRoutes.route("/organizations",organizationRoutes);
identityRoutes.route("/organizations",recipientRoutes);
identityRoutes.route("/invitations",invitationRoutes);
identityRoutes.route("/recipient-portal",recipientPortalRoutes);

export { requireUser, requireOrganization, getAccess, PERMISSIONS } from "./session";
export { getRecipient, listRecipients, type RecipientRecord } from "./recipients";
