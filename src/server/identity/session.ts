import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import { getDb, row, rows } from "../db";
import { ApiError, type AccessContext, type AppEnv } from "../context";
import { hashToken, newToken } from "./crypto";

const SESSION_COOKIE = "razor_session";
const HOURS = 8;
export const PERMISSIONS = ["company:read", "company:manage", "recipients:read", "recipients:manage", "payments:read", "payments:prepare", "payments:approve", "payments:execute", "reports:read", "documents:manage"];

export interface SessionRecord {
  id: string;
  user_id: string;
  organization_id: string | null;
  created_at: string;
  expires_at: string;
}

export function appOrigin(): string {
  return new URL(process.env.APP_URL || "http://localhost:3000").origin;
}

export function verifyOrigin(c: Context<AppEnv>): void {
  const origin = c.req.header("origin");
  if (!origin || origin !== appOrigin()) throw new ApiError(403, "Request origin is not allowed", "ORIGIN_REJECTED");
}

export function currentSession(c: Context<AppEnv>): SessionRecord | undefined {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return undefined;
  return row<SessionRecord>("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?", hashToken(token), new Date().toISOString());
}

export function issueSession(c: Context<AppEnv>, userId: string): void {
  const token = newToken();
  const now = new Date().toISOString();
  getDb().prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(randomUUID(), userId, hashToken(token), new Date(Date.now() + HOURS * 3600000).toISOString(), now);
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Strict", secure: appOrigin().startsWith("https:"), path: "/", maxAge: HOURS * 3600 });
}

export function revokeSession(c: Context<AppEnv>): void {
  const session = currentSession(c);
  if (session) getDb().prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = currentSession(c);
  if (!session) throw new ApiError(401, "Sign in to continue", "UNAUTHENTICATED");
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) verifyOrigin(c);
  c.set("userId", session.user_id);
  await next();
};

export function getAccess(userId: string, orgId: string): AccessContext {
  const membership = row<{ permissions_json: string }>(
    `SELECT r.permissions_json FROM memberships m JOIN organization_roles r ON r.id = m.role_id AND r.organization_id = m.organization_id
     WHERE m.organization_id = ? AND m.user_id = ? AND m.status = 'active'`, orgId, userId,
  );
  if (!membership) throw new ApiError(403, "You do not have access to this company", "COMPANY_ACCESS_DENIED");
  return { userId, organizationId: orgId, permissions: JSON.parse(membership.permissions_json) as string[] };
}

export function requireOrganization(permission: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) verifyOrigin(c);
    const userId = c.get("userId") || currentSession(c)?.user_id;
    if (!userId) throw new ApiError(401, "Sign in to continue", "UNAUTHENTICATED");
    const orgId = c.req.param("orgId");
    if (!orgId) throw new ApiError(400, "Company is required", "COMPANY_REQUIRED");
    const access = getAccess(userId, orgId);
    if (!access.permissions.includes(permission)) throw new ApiError(403, "Your role does not permit this action", "FORBIDDEN");
    c.set("userId", userId);
    c.set("access", access);
    await next();
  };
}

export function organizationsFor(userId: string) {
  return rows<{permissions_json:string}>("SELECT o.*, r.name AS role,r.permissions_json FROM organizations o JOIN memberships m ON m.organization_id = o.id JOIN organization_roles r ON r.id = m.role_id AND r.organization_id = o.id WHERE m.user_id = ? AND m.status = 'active' ORDER BY o.created_at", userId).map(({permissions_json,...organization})=>({...organization,permissions:JSON.parse(permissions_json) as string[]}));
}

export function audit(userId: string, organizationId: string | null, action: string, entityId?: string, details: Record<string, unknown> = {}): void {
  getDb().prepare("INSERT INTO identity_audit (id, organization_id, user_id, action, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), organizationId, userId, action, entityId ?? null, JSON.stringify(details), new Date().toISOString());
}
