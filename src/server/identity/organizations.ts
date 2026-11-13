import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, type AppEnv } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { hashToken, newToken } from "./crypto";
import { normalizeWallet } from "./auth";
import { PERMISSIONS, appOrigin, audit, currentSession, organizationsFor, requireOrganization, requireUser } from "./session";

const Name = z.string().trim().min(2).max(120);
const Timezone = z.string().max(80).refine((value) => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Choose a valid timezone");
const RoleInput = z.object({ name: Name, permissions: z.array(z.string().refine((value) => PERMISSIONS.includes(value), "Unknown permission")).max(PERMISSIONS.length) });

const permissionDependencies: Record<string,string[]> = {
  "recipients:manage": ["recipients:read"],
  "payments:prepare": ["payments:read"],
  "payments:approve": ["payments:read"],
  "payments:execute": ["payments:read"],
};
function validatePermissions(permissions:string[]) {
  if (!permissions.includes("company:read")) throw new ApiError(422,"Every company role needs View company workspace access","ROLE_WORKSPACE_PERMISSION_REQUIRED");
  for (const permission of permissions) for (const required of permissionDependencies[permission] || []) {
    if (!permissions.includes(required)) throw new ApiError(422,`${permission} also requires ${required}`,"ROLE_PERMISSION_DEPENDENCY_REQUIRED");
  }
}

function roleFor(orgId: string, roleId: string, includeArchived=false) {
  const role = row<{ id: string; is_owner: number; name: string; permissions_json: string; archived_at:string|null }>(`SELECT * FROM organization_roles WHERE id = ? AND organization_id = ? ${includeArchived ? "" : "AND archived_at IS NULL"}`, roleId, orgId);
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

organizationRoutes.get("/:orgId/roles", requireOrganization("company:manage"), (c) => {
  const all=rows<{permissions_json:string;archived_at:string|null}>("SELECT * FROM organization_roles WHERE organization_id = ? ORDER BY is_owner DESC,name",c.req.param("orgId")).map(({permissions_json,...role})=>({...role,permissions:JSON.parse(permissions_json)}));
  return c.json({permissions:PERMISSIONS,requiredPermissions:["company:read"],permissionDependencies,roles:all.filter(role=>!role.archived_at),archivedRoles:all.filter(role=>!!role.archived_at)});
});

organizationRoutes.post("/:orgId/roles", requireOrganization("company:manage"), async (c) => {
  const input = RoleInput.parse(await c.req.json()), id = randomUUID(), orgId = c.req.param("orgId");
  validatePermissions(input.permissions);
  const existing=row<{archived_at:string|null}>("SELECT archived_at FROM organization_roles WHERE organization_id = ? AND name = ?",orgId,input.name);
  if (existing) throw new ApiError(409,existing.archived_at?"This role is archived. Restore it from archived roles to reuse its name.":"A role with this name already exists",existing.archived_at?"ROLE_ARCHIVED":"ROLE_EXISTS");
  getDb().prepare("INSERT INTO organization_roles (id,organization_id,name,permissions_json,created_at) VALUES (?,?,?,?,?)")
    .run(id,orgId,input.name,JSON.stringify([...new Set(input.permissions)]),new Date().toISOString());
  audit(c.get("userId"),orgId,"role.created",id);
  return c.json({ role: {id,name:input.name,permissions:input.permissions} },201);
});

organizationRoutes.patch("/:orgId/roles/:roleId", requireOrganization("company:manage"), async (c) => {
  const input = RoleInput.parse(await c.req.json()), orgId = c.req.param("orgId"), role = roleFor(orgId,c.req.param("roleId"));
  if (role.is_owner) throw new ApiError(409,"Owner permissions cannot be changed","OWNER_ROLE_PROTECTED");
  validatePermissions(input.permissions);
  if (row("SELECT id FROM organization_roles WHERE organization_id = ? AND name = ? AND id != ?",orgId,input.name,role.id)) throw new ApiError(409,"A role with this name already exists","ROLE_EXISTS");
  getDb().prepare("UPDATE organization_roles SET name = ?,permissions_json = ? WHERE id = ?").run(input.name,JSON.stringify([...new Set(input.permissions)]),role.id);
  audit(c.get("userId"),orgId,"role.updated",role.id);
  return c.json({ role: {id:role.id,name:input.name,permissions:input.permissions} });
});

organizationRoutes.delete("/:orgId/roles/:roleId", requireOrganization("company:manage"), (c) => {
  const orgId = c.req.param("orgId"), role = roleFor(orgId,c.req.param("roleId"));
  if (role.is_owner) throw new ApiError(409,"The owner role cannot be archived","OWNER_ROLE_PROTECTED");
  transaction(db=>{
    if (row("SELECT user_id FROM memberships WHERE role_id = ? AND status='active' UNION ALL SELECT id FROM organization_invitations WHERE role_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?",role.id,role.id,new Date().toISOString())) throw new ApiError(409,"Reassign active members and revoke pending invitations before archiving this role","ROLE_IN_USE");
    db.prepare("UPDATE organization_roles SET archived_at=? WHERE id=?").run(new Date().toISOString(),role.id);
    audit(c.get("userId"),orgId,"role.archived",role.id);
  });
  return c.json({ ok: true });
});

organizationRoutes.post("/:orgId/roles/:roleId/restore", requireOrganization("company:manage"), async(c) => {
  const input=RoleInput.parse(await c.req.json()),orgId=c.req.param("orgId"),role=roleFor(orgId,c.req.param("roleId"),true);
  validatePermissions(input.permissions);
  if(!role.archived_at)throw new ApiError(409,"This role is already active","ROLE_ALREADY_ACTIVE");
  if(row("SELECT id FROM organization_roles WHERE organization_id=? AND name=? AND id!=?",orgId,input.name,role.id))throw new ApiError(409,"A role with this name already exists","ROLE_EXISTS");
  getDb().prepare("UPDATE organization_roles SET archived_at=NULL,name=?,permissions_json=? WHERE id=?").run(input.name,JSON.stringify([...new Set(input.permissions)]),role.id);
  audit(c.get("userId"),orgId,"role.restored",role.id);
  return c.json({ok:true});
});

interface Invitation {
  id:string;organization_id:string;role_id:string;email:string|null;wallet_family:string|null;wallet_address:string|null;wallet_network:string|null;expires_at:string;accepted_at:string|null;accepted_by:string|null;revoked_at:string|null;
}
const WalletTarget=z.object({family:z.enum(["near","evm","solana"]),address:z.string().trim().min(2).max(128),network:z.string().max(40).optional()});
const InvitationInput=z.object({email:z.email().max(254).optional(),wallet:WalletTarget.optional(),roleId:z.string().uuid()}).refine(input=>!!input.email!==!!input.wallet,"Choose exactly one invitation target: email or wallet");
function targetMatches(invitation:Invitation,userId:string) {
  if(invitation.email)return row<{email:string|null}>("SELECT email FROM users WHERE id=?",userId)?.email?.toLowerCase()===invitation.email.toLowerCase();
  return !!row("SELECT id FROM linked_wallets WHERE user_id=? AND family=? AND address=? AND network=? AND last_verified_at IS NOT NULL",userId,invitation.wallet_family!,invitation.wallet_address!,invitation.wallet_network!);
}
function findInvitation(token:string) {
  const invitation=row<Invitation>("SELECT * FROM organization_invitations WHERE token_hash=?",hashToken(token));
  if(!invitation)throw new ApiError(404,"This invitation is unavailable","INVITATION_UNAVAILABLE");
  return invitation;
}
function invitationState(invitation:Invitation) {
  return invitation.accepted_at?"accepted":invitation.revoked_at?"revoked":invitation.expires_at<=new Date().toISOString()?"expired":"pending";
}

organizationRoutes.get("/:orgId/invitations", requireOrganization("company:manage"), (c) => c.json({ invitations: rows("SELECT i.id,i.email,i.wallet_family,i.wallet_address,i.wallet_network,i.role_id,r.name AS role,i.expires_at,i.accepted_at,i.revoked_at,i.created_at FROM organization_invitations i JOIN organization_roles r ON r.id = i.role_id WHERE i.organization_id = ? ORDER BY i.created_at DESC",c.req.param("orgId")) }));

organizationRoutes.post("/:orgId/invitations", requireOrganization("company:manage"), async (c) => {
  const input=InvitationInput.parse(await c.req.json()),orgId=c.req.param("orgId"),role=roleFor(orgId,input.roleId),token=newToken(),id=randomUUID();
  if(role.is_owner)throw new ApiError(400,"Invite a company administrator instead of another owner","OWNER_ROLE_PROTECTED");
  validatePermissions(JSON.parse(role.permissions_json));
  const address=input.wallet?normalizeWallet(input.wallet.family,input.wallet.address):null;
  const network=input.wallet?(input.wallet.family==="near"?input.wallet.network || process.env.NEAR_NETWORK || "testnet":input.wallet.family):null;
  if(input.wallet?.family==="near"&&!['mainnet','testnet'].includes(network!))throw new ApiError(400,"Choose the NEAR mainnet or testnet identity to invite","INVALID_NETWORK");
  const now=new Date().toISOString(),expiresAt=new Date(Date.now()+7*86400000).toISOString();
  getDb().prepare("INSERT INTO organization_invitations (id,organization_id,email,wallet_family,wallet_address,wallet_network,role_id,token_hash,created_by,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id,orgId,input.email?.toLowerCase() || null,input.wallet?.family || null,address,network,role.id,hashToken(token),c.get("userId"),expiresAt,now);
  audit(c.get("userId"),orgId,"member.invited",id,{roleId:role.id});
  return c.json({invitation:{id,email:input.email || null,wallet:input.wallet?{family:input.wallet.family,address,network}:null,roleId:role.id,expiresAt},invitationUrl:`${appOrigin()}/join?token=${token}`,delivery:"copy_link"},201);
});

organizationRoutes.delete("/:orgId/invitations/:invitationId", requireOrganization("company:manage"), (c) => {
  getDb().prepare("UPDATE organization_invitations SET revoked_at = ? WHERE id = ? AND organization_id = ? AND accepted_at IS NULL").run(new Date().toISOString(),c.req.param("invitationId"),c.req.param("orgId"));
  return c.json({ok:true});
});

export const invitationRoutes = new Hono<AppEnv>();
invitationRoutes.use("*",requireUser);
invitationRoutes.get("/:token",c=>{
  const token=z.string().min(32).max(100).parse(c.req.param("token")),invitation=findInvitation(token),userId=c.get("userId"),status=invitationState(invitation);
  const membership=row("SELECT user_id FROM memberships WHERE organization_id=? AND user_id=? AND status='active'",invitation.organization_id,userId);
  const match=targetMatches(invitation,userId),acceptedForUser=invitation.accepted_at&&(!invitation.accepted_by||invitation.accepted_by===userId)&&!!membership;
  return c.json({company:row("SELECT id,name FROM organizations WHERE id=?",invitation.organization_id),role:row<{name:string}>("SELECT name FROM organization_roles WHERE id=?",invitation.role_id)?.name,target:{email:invitation.email,wallet:invitation.wallet_family?{family:invitation.wallet_family,address:invitation.wallet_address,network:invitation.wallet_network}:null},status,canAccept:match&&(status==="pending"||!!acceptedForUser),identityMatches:match});
});
invitationRoutes.post("/accept",async(c)=>{
  const {token}=z.object({token:z.string().min(32).max(100)}).parse(await c.req.json()),userId=c.get("userId"),invitation=findInvitation(token);
  if(!targetMatches(invitation,userId))throw new ApiError(403,invitation.email?"Sign in with the verified email address invited by your company. Link that Google or email sign-in first.":"Verify and link the invited wallet to this Razor account before accepting.",invitation.email?"INVITATION_EMAIL_MISMATCH":"INVITATION_WALLET_MISMATCH");
  transaction(db=>{
    const current=findInvitation(token),membership=row("SELECT user_id FROM memberships WHERE organization_id=? AND user_id=? AND status='active'",current.organization_id,userId);
    if(current.accepted_at){
      if(current.accepted_by&&current.accepted_by!==userId)throw new ApiError(403,"This invitation belongs to a different account","INVITATION_ACCOUNT_MISMATCH");
      if(!membership)throw new ApiError(409,"This invitation was used and your company access has ended. Ask for a new invitation.","INVITATION_MEMBERSHIP_ENDED");
    }else{
      if(invitationState(current)!=="pending")throw new ApiError(404,"This invitation was revoked or has expired","INVITATION_UNAVAILABLE");
      const role=roleFor(current.organization_id,current.role_id);
      validatePermissions(JSON.parse(role.permissions_json));
      if(membership)throw new ApiError(409,"You already belong to this company. Open it from your company switcher.","ALREADY_A_MEMBER");
      const consumed=db.prepare("UPDATE organization_invitations SET accepted_at=?,accepted_by=? WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?").run(new Date().toISOString(),userId,current.id,new Date().toISOString());
      if(!consumed.changes)throw new ApiError(409,"This invitation is no longer available","INVITATION_UNAVAILABLE");
      db.prepare("INSERT INTO memberships (organization_id,user_id,role_id,created_at) VALUES (?,?,?,?) ON CONFLICT(organization_id,user_id) DO UPDATE SET role_id=excluded.role_id,status='active'").run(current.organization_id,userId,current.role_id,new Date().toISOString());
      audit(userId,current.organization_id,"member.joined",userId);
    }
    db.prepare("UPDATE sessions SET organization_id=? WHERE id=?").run(current.organization_id,currentSession(c)!.id);
  });
  return c.json({organizationId:invitation.organization_id});
});
