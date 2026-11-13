"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, control, DataTable, Empty, Field, Panel, Status } from "./shared";

interface Role {id:string;name:string;permissions:string[];is_owner:number}
interface Member {id:string;name:string;email:string|null;role_id:string;role:string;created_at:string}
interface Invitation {id:string;email:string;role_id:string;role:string;expires_at:string;accepted_at:string|null;revoked_at:string|null}
const LABELS:Record<string,string>={"company:read":"View company workspace","company:manage":"Manage company and team access","recipients:read":"View payees and destinations","recipients:manage":"Add and manage payees","payments:read":"View payment records","payments:prepare":"Prepare payment drafts and quotes","payments:approve":"Approve payments in Razor","payments:execute":"Request wallet payment execution","reports:read":"View reports and ledger","documents:manage":"Manage company documents"};

export function TeamAccessPanel() {
  const {base,revision,refresh,session}=useWorkspace(),{data:roles,error:rolesError}=useResource<{roles:Role[];permissions:string[]}>(`${base}/roles`,revision),{data:members,error:membersError}=useResource<{members:Member[]}>(`${base}/members`,revision),{data:invitations,error:inviteError}=useResource<{invitations:Invitation[]}>(`${base}/invitations`,revision),{busy,error,run}=useAction();
  const [inviteLink,setInviteLink]=useState<{email:string;url:string}|null>(null),[editingRole,setEditingRole]=useState<Role|"new"|null>(null),[roleName,setRoleName]=useState(""),[permissions,setPermissions]=useState<string[]>([]),[assignments,setAssignments]=useState<Record<string,string>>({});
  const assignable=roles?.roles.filter(role=>!role.is_owner) || [];
  function editRole(role:Role|"new") {setEditingRole(role);setRoleName(role==="new"?"":role.name);setPermissions(role==="new"?["company:read"]:[...role.permissions]);}
  async function removeMember(member:Member) {
    if(!window.confirm(`Remove ${member.email || member.name} from this company? Their company access ends immediately.`))return;
    await api(`${base}/members/${member.id}`,undefined,"DELETE");refresh();
  }
  async function deleteRole(role:Role) {
    if(!window.confirm(`Delete the ${role.name} role? Reassign its members and invitations first. This cannot be undone.`))return;
    await api(`${base}/roles/${role.id}`,undefined,"DELETE");if(editingRole!==null&&editingRole!=="new"&&editingRole.id===role.id)setEditingRole(null);refresh();
  }
  const loadError=rolesError || membersError || inviteError;
  return <div className="grid gap-6"><Panel title="Team invitations" description="Invite a verified email address and assign a company role. A Razor role does not grant authority over the NEAR treasury by itself.">
    {loadError?<p role="alert" className="mb-4 text-sm text-destructive">{loadError}</p>:null}
    <form className="grid gap-4 md:grid-cols-3" onSubmit={event=>{event.preventDefault();const form=event.currentTarget,values=new FormData(form);void run("invite",async()=>{const result=await api<{invitationUrl:string}>(`${base}/invitations`,{email:values.get("email"),roleId:values.get("roleId")});setInviteLink({email:String(values.get("email")),url:result.invitationUrl});form.reset();refresh();});}}>
      <Field label="Email to invite"><input name="email" type="email" required className={control} disabled={!!busy}/></Field>
      <Field label="Company role"><select name="roleId" required className={control} disabled={!!busy}><option value="">Choose role</option>{assignable.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}</select></Field>
      <div className="self-end"><Action busy={busy==="invite"} disabled={!!busy||!roles}>Create invitation link</Action></div>
    </form>
    {inviteLink?<div className="mt-4 rounded-lg bg-secondary p-4 text-sm"><p>Share this link with {inviteLink.email}</p><input readOnly value={inviteLink.url} aria-label="Company invitation link" className={`${control} mt-2`} onFocus={event=>event.target.select()}/><p className="mt-2 text-xs text-muted-foreground">No email has been sent. The recipient must sign in with this verified email address.</p></div>:null}
    {error?<p role="alert" className="mt-4 text-sm text-destructive">{error}</p>:null}
  </Panel>
  <Panel title="Company members" description="The owner role is protected. Changes to company permissions apply to subsequent requests.">{!members?.members.length?<Empty>No member records loaded.</Empty>:<DataTable columns={["Member", "Role", "Actions"]}>{members.members.map(member=>{
    const isOwner=roles?.roles.find(role=>role.id===member.role_id)?.is_owner===1,nextRole=assignments[member.id] || member.role_id;
    return <tr key={member.id}><td><p className="font-medium">{member.name}{member.id===session.user.id?" (you)":""}</p><p className="mt-1 text-xs text-muted-foreground">{member.email}</p></td><td>{isOwner?<Status value="owner"/>:<select aria-label={`Role for ${member.name}`} value={nextRole} disabled={!!busy} className={control} onChange={event=>setAssignments(current=>({...current,[member.id]:event.target.value}))}>{assignable.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}</select>}</td><td>{!isOwner?<div className="flex flex-wrap gap-3"><Action busy={busy===`assign:${member.id}`} disabled={!!busy||nextRole===member.role_id} onClick={()=>void run(`assign:${member.id}`,async()=>{if(member.id===session.user.id&&!window.confirm("Change your own role? You may lose access to team management."))return;await api(`${base}/members/${member.id}`,{roleId:nextRole},"PATCH");setAssignments(current=>{const next={...current};delete next[member.id];return next;});refresh();})}>Save role</Action><button type="button" className="text-sm text-destructive" disabled={!!busy} onClick={()=>void run(`remove:${member.id}`,()=>removeMember(member))}>Remove member</button></div>:<span className="text-xs text-muted-foreground">Owner protected</span>}</td></tr>;
  })}</DataTable>}</Panel>
  <Panel title="Invitation history" description="Revoking a pending invitation prevents its secure link from being accepted.">{!invitations?.invitations.length?<Empty>No invitations yet.</Empty>:<DataTable columns={["Email", "Role", "Status", "Actions"]}>{invitations.invitations.map(invite=>{
    const status=invite.accepted_at?"accepted":invite.revoked_at?"revoked":Date.parse(invite.expires_at)<=Date.now()?"expired":"pending";
    return <tr key={invite.id}><td>{invite.email}</td><td>{invite.role}</td><td><Status value={status}/><p className="mt-2 text-xs text-muted-foreground">Expires {new Date(invite.expires_at).toLocaleString()}</p></td><td>{status==="pending"?<button type="button" disabled={!!busy} className="text-sm text-destructive" onClick={()=>{if(window.confirm(`Revoke the invitation for ${invite.email}?`))void run(`revoke:${invite.id}`,async()=>{await api(`${base}/invitations/${invite.id}`,undefined,"DELETE");if(inviteLink?.email.toLowerCase()===invite.email.toLowerCase())setInviteLink(null);refresh();});}}>Revoke invitation</button>:null}</td></tr>;
  })}</DataTable>}</Panel>
  <Panel title="Company roles" description="Customize the permissions used by Razor. NEAR contract owner, approver and executor permissions remain separate wallet-controlled settings." action={<Action disabled={!!busy||!roles} onClick={()=>editRole("new")}>Create custom role</Action>}>
    <DataTable columns={["Role", "Permissions", "Actions"]}>{roles?.roles.map(role=><tr key={role.id}><td className="font-medium">{role.name}</td><td><div className="flex max-w-xl flex-wrap gap-2">{role.permissions.map(permission=><span key={permission} className="rounded bg-muted px-2 py-1 text-xs">{LABELS[permission] || permission}</span>)}</div></td><td>{role.is_owner?<span className="text-xs text-muted-foreground">Owner protected</span>:<div className="flex flex-wrap gap-3"><button type="button" disabled={!!busy} className="text-sm text-primary" onClick={()=>editRole(role)}>Edit role</button><button type="button" disabled={!!busy} className="text-sm text-destructive" onClick={()=>void run(`delete-role:${role.id}`,()=>deleteRole(role))}>Delete role</button></div>}</td></tr>)}</DataTable>
    {editingRole?<form className="mt-6 space-y-4 rounded-lg border p-4" onSubmit={event=>{event.preventDefault();void run("role",async()=>{await api(`${base}/roles${editingRole==="new"?"":`/${editingRole.id}`}`,{name:roleName,permissions},editingRole==="new"?"POST":"PATCH");setEditingRole(null);refresh();});}}><fieldset disabled={!!busy} className="min-w-0 space-y-4 border-0 p-0"><Field label={editingRole==="new"?"New role name":"Role name"}><input required minLength={2} maxLength={120} className={control} value={roleName} onChange={event=>setRoleName(event.target.value)}/></Field><div className="grid gap-3 sm:grid-cols-2">{roles?.permissions.map(permission=><label key={permission} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={permissions.includes(permission)} onChange={event=>setPermissions(current=>event.target.checked?[...current,permission]:current.filter(value=>value!==permission))}/>{LABELS[permission] || permission}</label>)}</div>{!permissions.includes("company:read")?<p className="text-sm text-amber-800">Members without company workspace access cannot open company screens. Keep View company workspace enabled for working team roles.</p>:null}<div className="flex gap-3"><Action busy={busy==="role"}>Save role permissions</Action><Action type="button" onClick={()=>setEditingRole(null)}>Cancel</Action></div></fieldset></form>:null}
  </Panel></div>;
}
