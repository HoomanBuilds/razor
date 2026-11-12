import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, type AppEnv } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { hashToken, newToken } from "./crypto";
import { PERMISSIONS, appOrigin, audit, currentSession, organizationsFor, requireOrganization, requireUser } from "./session";

const Name = z.string().trim().min(2).max(120);
const Timezone = z.string().max(80).refine((value) => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Choose a valid timezone");
const RoleInput = z.object({ name: Name, permissions: z.array(z.string().refine((value) => PERMISSIONS.includes(value), "Unknown permission")).max(PERMISSIONS.length) });

function roleFor(orgId: string, roleId: string) {
  const role = row<{ id: string; is_owner: number; name: string; permissions_json: string }>("SELECT * FROM organization_roles WHERE id = ? AND organization_id = ?", roleId, orgId);
  if (!role) throw new ApiError(404, "Role not found in this company", "ROLE_NOT_FOUND");
  return role;
}

export const organizationRoutes = new Hono<AppEnv>();
organizationRoutes.use("*", requireUser);

organizationRoutes.get("/", (c) => c.json({ organizations: organizationsFor(c.get("userId")) }));

organizationRoutes.post("/", async (c) => {
  const input = z.object({ name: Name, timezone: Timezone.default("UTC") }).parse(await c.req.json());
  const id = randomUUID(), userId = c.get("userId"), now = new Date().toISOString();
  transaction((db) => {
    db.prepare("INSERT INTO organizations (id,name,timezone,settlement_asset,owner_id,near_network,created_at,updated_at) VALUES (?,?,?,'USDC',?,?,?,?)").run(id,input.name,input.timezone,userId,process.env.NEAR_NETWORK || "testnet",now,now);
    const roles = [
      { name: "Owner", permissions: PERMISSIONS, owner: 1 },
      { name: "Administrator", permissions: PERMISSIONS, owner: 0 },
      { name: "Operator", permissions: ["company:read","recipients:read","recipients:manage","payments:read","payments:prepare","documents:manage","reports:read"], owner: 0 },
      { name: "Approver", permissions: ["company:read","recipients:read","payments:read","payments:approve","reports:read"], owner: 0 },
      { name: "Viewer", permissions: ["company:read","payments:read","reports:read"], owner: 0 },
    ];
    for (const role of roles) {
      const roleId = randomUUID();
      db.prepare("INSERT INTO organization_roles (id,organization_id,name,permissions_json,is_owner,created_at) VALUES (?,?,?,?,?,?)").run(roleId,id,role.name,JSON.stringify(role.permissions),role.owner,now);
      if (role.owner) db.prepare("INSERT INTO memberships (organization_id,user_id,role_id,created_at) VALUES (?,?,?,?)").run(id,userId,roleId,now);
    }
    db.prepare("UPDATE sessions SET organization_id = ? WHERE id = ?").run(id,currentSession(c)!.id);
    audit(userId,id,"company.created",id);
  });
  return c.json({ organization: row("SELECT * FROM organizations WHERE id = ?",id) },201);
});

organizationRoutes.get("/:orgId", requireOrganization("company:read"), (c) => c.json({ organization: row("SELECT * FROM organizations WHERE id = ?",c.req.param("orgId")), permissions: c.get("access").permissions }));

organizationRoutes.patch("/:orgId", requireOrganization("company:manage"), async (c) => {
  const input = z.object({ name: Name.optional(), timezone: Timezone.optional(), paused: z.boolean().optional() }).parse(await c.req.json());
  const orgId = c.req.param("orgId");
  getDb().prepare("UPDATE organizations SET name = COALESCE(?,name), timezone = COALESCE(?,timezone), paused = COALESCE(?,paused),updated_at = ? WHERE id = ?")
    .run(input.name ?? null,input.timezone ?? null,input.paused === undefined ? null : Number(input.paused),new Date().toISOString(),orgId);
  audit(c.get("userId"),orgId,"company.updated",orgId);
  return c.json({ organization: row("SELECT * FROM organizations WHERE id = ?",orgId) });
});

organizationRoutes.post("/:orgId/select", requireOrganization("company:read"), (c) => {
  getDb().prepare("UPDATE sessions SET organization_id = ? WHERE id = ?").run(c.req.param("orgId"),currentSession(c)!.id);
  return c.json({ activeOrganizationId: c.req.param("orgId"), permissions: c.get("access").permissions });
});

organizationRoutes.get("/:orgId/members", requireOrganization("company:manage"), (c) => c.json({ members: rows("SELECT u.id,u.name,u.email,m.role_id,r.name AS role,m.created_at FROM memberships m JOIN users u ON u.id = m.user_id JOIN organization_roles r ON r.id = m.role_id WHERE m.organization_id = ? AND m.status = 'active'",c.req.param("orgId")) }));

organizationRoutes.patch("/:orgId/members/:userId", requireOrganization("company:manage"), async (c) => {
  const input = z.object({ roleId: z.string().uuid() }).parse(await c.req.json());
  const orgId = c.req.param("orgId"), userId = c.req.param("userId"), role = roleFor(orgId,input.roleId);
  if (role.is_owner) throw new ApiError(400,"The owner role cannot be assigned. Use a separate company administrator.","OWNER_ROLE_PROTECTED");
  const owner = row<{ owner_id: string }>("SELECT owner_id FROM organizations WHERE id = ?",orgId)!;
  if (owner.owner_id === userId) throw new ApiError(409,"The company owner must retain the owner role","OWNER_ROLE_PROTECTED");
  const result = getDb().prepare("UPDATE memberships SET role_id = ? WHERE organization_id = ? AND user_id = ? AND status = 'active'").run(role.id,orgId,userId);
  if (!result.changes) throw new ApiError(404,"Member not found","NOT_FOUND");
  audit(c.get("userId"),orgId,"member.role_changed",userId,{ roleId: role.id });
  return c.json({ ok: true });
});

organizationRoutes.delete("/:orgId/members/:userId", requireOrganization("company:manage"), (c) => {
  const orgId = c.req.param("orgId"), userId = c.req.param("userId");
  if (row<{owner_id:string}>("SELECT owner_id FROM organizations WHERE id = ?",orgId)!.owner_id === userId) throw new ApiError(409,"The company owner cannot be removed","OWNER_ROLE_PROTECTED");
  const result = getDb().prepare("UPDATE memberships SET status = 'removed' WHERE organization_id = ? AND user_id = ?").run(orgId,userId);
  if (!result.changes) throw new ApiError(404,"Member not found","NOT_FOUND");
  getDb().prepare("UPDATE sessions SET organization_id = NULL WHERE user_id = ? AND organization_id = ?").run(userId,orgId);
  audit(c.get("userId"),orgId,"member.removed",userId);
  return c.json({ ok: true });
});

organizationRoutes.get("/:orgId/roles", requireOrganization("company:manage"), (c) => c.json({ permissions: PERMISSIONS, roles: rows<{permissions_json:string}>("SELECT * FROM organization_roles WHERE organization_id = ? ORDER BY is_owner DESC,name",c.req.param("orgId")).map(({permissions_json,...role}) => ({...role,permissions:JSON.parse(permissions_json)})) }));

organizationRoutes.post("/:orgId/roles", requireOrganization("company:manage"), async (c) => {
  const input = RoleInput.parse(await c.req.json()), id = randomUUID(), orgId = c.req.param("orgId");
  if (row("SELECT id FROM organization_roles WHERE organization_id = ? AND name = ?",orgId,input.name)) throw new ApiError(409,"A role with this name already exists","ROLE_EXISTS");
  getDb().prepare("INSERT INTO organization_roles (id,organization_id,name,permissions_json,created_at) VALUES (?,?,?,?,?)").run(id,orgId,input.name,JSON.stringify([...new Set(input.permissions)]),new Date().toISOString());
  audit(c.get("userId"),orgId,"role.created",id);
  return c.json({ role: {id,name:input.name,permissions:input.permissions} },201);
});

organizationRoutes.patch("/:orgId/roles/:roleId", requireOrganization("company:manage"), async (c) => {
  const input = RoleInput.parse(await c.req.json()), orgId = c.req.param("orgId"), role = roleFor(orgId,c.req.param("roleId"));
  if (role.is_owner) throw new ApiError(409,"Owner permissions cannot be changed","OWNER_ROLE_PROTECTED");
  if (row("SELECT id FROM organization_roles WHERE organization_id = ? AND name = ? AND id != ?",orgId,input.name,role.id)) throw new ApiError(409,"A role with this name already exists","ROLE_EXISTS");
  getDb().prepare("UPDATE organization_roles SET name = ?,permissions_json = ? WHERE id = ?").run(input.name,JSON.stringify([...new Set(input.permissions)]),role.id);
  audit(c.get("userId"),orgId,"role.updated",role.id);
  return c.json({ role: {id:role.id,name:input.name,permissions:input.permissions} });
});

organizationRoutes.delete("/:orgId/roles/:roleId", requireOrganization("company:manage"), (c) => {
  const orgId = c.req.param("orgId"), role = roleFor(orgId,c.req.param("roleId"));
  if (role.is_owner) throw new ApiError(409,"The owner role cannot be removed","OWNER_ROLE_PROTECTED");
  if (row("SELECT user_id FROM memberships WHERE role_id = ? UNION ALL SELECT id FROM organization_invitations WHERE role_id = ?",role.id,role.id)) throw new ApiError(409,"Reassign this role's members and invitations before removing it","ROLE_IN_USE");
  getDb().prepare("DELETE FROM organization_roles WHERE id = ?").run(role.id);
  audit(c.get("userId"),orgId,"role.deleted",role.id);
  return c.json({ ok: true });
});

organizationRoutes.get("/:orgId/invitations", requireOrganization("company:manage"), (c) => c.json({ invitations: rows("SELECT i.id,i.email,i.role_id,r.name AS role,i.expires_at,i.accepted_at,i.revoked_at,i.created_at FROM organization_invitations i JOIN organization_roles r ON r.id = i.role_id WHERE i.organization_id = ?",c.req.param("orgId")) }));

organizationRoutes.post("/:orgId/invitations", requireOrganization("company:manage"), async (c) => {
  const input = z.object({email:z.email().max(254),roleId:z.string().uuid()}).parse(await c.req.json());
  const orgId = c.req.param("orgId"), role = roleFor(orgId,input.roleId), token = newToken(), id = randomUUID();
  if (role.is_owner) throw new ApiError(400,"Invite a company administrator instead of another owner","OWNER_ROLE_PROTECTED");
  const now = new Date().toISOString(), expiresAt = new Date(Date.now()+7*86400000).toISOString();
  getDb().prepare("INSERT INTO organization_invitations (id,organization_id,email,role_id,token_hash,created_by,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)").run(id,orgId,input.email.toLowerCase(),role.id,hashToken(token),c.get("userId"),expiresAt,now);
  audit(c.get("userId"),orgId,"member.invited",id,{roleId:role.id});
  return c.json({ invitation: {id,email:input.email,roleId:role.id,expiresAt}, invitationUrl: `${appOrigin()}/join?token=${token}`, delivery: "copy_link" },201);
});

organizationRoutes.delete("/:orgId/invitations/:invitationId", requireOrganization("company:manage"), (c) => {
  getDb().prepare("UPDATE organization_invitations SET revoked_at = ? WHERE id = ? AND organization_id = ? AND accepted_at IS NULL").run(new Date().toISOString(),c.req.param("invitationId"),c.req.param("orgId"));
  return c.json({ok:true});
});

export const invitationRoutes = new Hono<AppEnv>();
invitationRoutes.use("*",requireUser);
invitationRoutes.post("/accept",async(c)=>{
  const {token} = z.object({token:z.string().min(32).max(100)}).parse(await c.req.json()), userId = c.get("userId");
  const invitation = row<{id:string;organization_id:string;role_id:string;email:string}>("SELECT * FROM organization_invitations WHERE token_hash = ? AND expires_at > ? AND accepted_at IS NULL AND revoked_at IS NULL",hashToken(token),new Date().toISOString());
  if(!invitation) throw new ApiError(404,"This invitation has expired or was already used","INVITATION_UNAVAILABLE");
  const user = row<{email:string|null}>("SELECT email FROM users WHERE id = ?",userId)!;
  if(user.email?.toLowerCase()!==invitation.email) throw new ApiError(403,"Sign in with the verified email address this invitation was sent to. Link Google or email sign-in in your account first.","INVITATION_EMAIL_MISMATCH");
  transaction((db)=>{
    const consumed=db.prepare("UPDATE organization_invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?").run(new Date().toISOString(),invitation.id,new Date().toISOString());
    if(!consumed.changes) throw new ApiError(409,"This invitation is no longer available","INVITATION_UNAVAILABLE");
    if(row("SELECT user_id FROM memberships WHERE organization_id = ? AND user_id = ? AND status = 'active'",invitation.organization_id,userId)) throw new ApiError(409,"You already belong to this company","ALREADY_A_MEMBER");
    db.prepare("INSERT INTO memberships (organization_id,user_id,role_id,created_at) VALUES (?,?,?,?) ON CONFLICT(organization_id,user_id) DO UPDATE SET role_id = excluded.role_id,status = 'active'").run(invitation.organization_id,userId,invitation.role_id,new Date().toISOString());
    audit(userId,invitation.organization_id,"member.joined",userId);
  });
  return c.json({organizationId:invitation.organization_id});
});
