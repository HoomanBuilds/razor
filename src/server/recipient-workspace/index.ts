import { Hono } from "hono";
import { ApiError, type AppEnv } from "../context";
import { row, transaction } from "../db";
import { requireOrganization, requireUser } from "../identity";
import { getRecipient, PreferenceInput, saveVersion, validateProfile } from "../identity/recipients";
import { audit } from "../identity/session";
import { BACKUP_NETWORKS } from "../payments/policy";
import { companyRequests, invoiceInput, ownPayments, ownProfiles, ownRecipient, ownRequests, prepareInvoiceRequest, reviewInput, submitInvoice } from "./service";

export const recipientWorkspaceRoutes=new Hono<AppEnv>();
recipientWorkspaceRoutes.use("*",requireUser);
recipientWorkspaceRoutes.get("/",c=>c.json({profiles:ownProfiles(c.get("userId")),payments:ownPayments(c.get("userId")),requests:ownRequests(c.get("userId"))}));
recipientWorkspaceRoutes.get("/profiles/:id",c=>{
  const recipient=ownRecipient(c.get("userId"),c.req.param("id"));
  return c.json({recipient,organization:row("SELECT id,name FROM organizations WHERE id=?",recipient.organization_id),backupAsset:"USDC",backupNetworks:BACKUP_NETWORKS});
});
recipientWorkspaceRoutes.get("/profiles/:id/payments",c=>c.json({payments:ownPayments(c.get("userId"),c.req.param("id"))}));
recipientWorkspaceRoutes.post("/profiles/:id/confirm",async c=>{
  const userId=c.get("userId"),recipient=ownRecipient(userId,c.req.param("id"));
  if(recipient.archived)throw new ApiError(409,"Your payer archived this profile. Existing payment history remains available.","RECIPIENT_ARCHIVED");
  const input=await validateProfile(PreferenceInput.parse(await c.req.json()));
  if(input.fallbackConsent&&(!input.backupNetwork||!input.backupAddress))throw new ApiError(400,"Choose a complete backup route before consenting to USDC fallback","BACKUP_INCOMPLETE");
  transaction(db=>{
    const now=new Date().toISOString(),updated=db.prepare("UPDATE recipients SET primary_asset=?,primary_network=?,primary_address=?,backup_network=?,backup_address=?,fallback_consent=?,preference_status='confirmed',confirmed_at=?,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=? AND archived=0")
      .run(input.primaryAsset,input.primaryNetwork,input.primaryAddress,input.backupNetwork??null,input.backupAddress??null,Number(input.fallbackConsent),now,now,recipient.id,userId,input.expectedVersion);
    if(!updated.changes)throw new ApiError(409,"Your preferences changed. Refresh before confirming.","RECIPIENT_VERSION_CHANGED");
    saveVersion(getRecipient(recipient.organization_id,recipient.id),userId);
    audit(userId,recipient.organization_id,"recipient.preferences_confirmed",recipient.id,{version:input.expectedVersion+1,fallbackConsent:input.fallbackConsent});
  });
  return c.json({recipient:getRecipient(recipient.organization_id,recipient.id)});
});
recipientWorkspaceRoutes.post("/invoices",async c=>c.json({request:submitInvoice(c.get("userId"),invoiceInput.parse(await c.req.json()))},201));

export const companyInvoiceIntakeRoutes=new Hono<AppEnv>();
companyInvoiceIntakeRoutes.use("*",requireUser);
companyInvoiceIntakeRoutes.get("/",requireOrganization("payments:read"),c=>c.json({requests:companyRequests(c.get("access"))}));
companyInvoiceIntakeRoutes.post("/:id/prepare",requireOrganization("payments:prepare"),async c=>c.json(prepareInvoiceRequest(c.get("access"),c.req.param("id"),reviewInput.parse(await c.req.json()))));
