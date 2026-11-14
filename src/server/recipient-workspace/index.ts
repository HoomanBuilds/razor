import { Hono } from "hono";
import { z } from "zod";
import { ApiError, type AppEnv } from "../context";
import { row, transaction } from "../db";
import { requireOrganization, requireUser } from "../identity";
import { getRecipient, PreferenceInput, saveVersion, validateProfile } from "../identity/recipients";
import { audit } from "../identity/session";
import { BACKUP_NETWORKS } from "../payments/policy";
import { companyRequestPage, invoiceInput, ownPayment, ownPaymentActivity, ownPaymentPage, ownProfiles, ownRecipient, ownRequestPage, prepareInvoiceRequest, reviewInput, submitInvoice } from "./service";

export const recipientWorkspaceRoutes=new Hono<AppEnv>();
recipientWorkspaceRoutes.use("*",requireUser);
const Page=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(50)});
recipientWorkspaceRoutes.get("/",c=>{
  const userId=c.get("userId"),payments=ownPaymentPage(userId,1,50),requests=ownRequestPage(userId,1,50);
  return c.json({profiles:ownProfiles(userId),payments:payments.payments,requests:requests.requests,paymentPage:{total:payments.total,page:payments.page,pageSize:payments.pageSize,hasMore:payments.hasMore},requestPage:{total:requests.total,page:requests.page,pageSize:requests.pageSize,hasMore:requests.hasMore}});
});
recipientWorkspaceRoutes.get("/summary",c=>c.json(ownPaymentActivity(c.get("userId"),c.req.query("recipientId"))));
recipientWorkspaceRoutes.get("/payments",c=>{
  const page=Page.parse(c.req.query());
  return c.json(ownPaymentPage(c.get("userId"),page.page,page.pageSize,c.req.query("recipientId")));
});
recipientWorkspaceRoutes.get("/payments/:id",c=>c.json({payment:ownPayment(c.get("userId"),c.req.param("id"))}));
recipientWorkspaceRoutes.get("/invoices",c=>{
  const page=Page.parse(c.req.query());
  return c.json(ownRequestPage(c.get("userId"),page.page,page.pageSize));
});
recipientWorkspaceRoutes.get("/profiles",c=>c.json({profiles:ownProfiles(c.get("userId"))}));
recipientWorkspaceRoutes.get("/profiles/:id",c=>{
  const recipient=ownRecipient(c.get("userId"),c.req.param("id"));
  return c.json({recipient,organization:row("SELECT id,name FROM organizations WHERE id=?",recipient.organization_id),backupAsset:"USDC",backupNetworks:BACKUP_NETWORKS});
});
recipientWorkspaceRoutes.get("/profiles/:id/payments",c=>{
  const page=Page.parse(c.req.query());
  return c.json(ownPaymentPage(c.get("userId"),page.page,page.pageSize,c.req.param("id")));
});
recipientWorkspaceRoutes.post("/profiles/:id/confirm",async c=>{
  const userId=c.get("userId"),recipient=ownRecipient(userId,c.req.param("id"));
  if(recipient.archived)throw new ApiError(409,"Your payer archived this profile. Existing payment history remains available.","RECIPIENT_ARCHIVED");
  const input=await validateProfile(PreferenceInput.parse(await c.req.json()));
  if(input.fallbackConsent&&(!input.backupNetwork||!input.backupAddress))throw new ApiError(400,"Choose a complete backup route before consenting to USDC fallback","BACKUP_INCOMPLETE");
  transaction(db=>{
    const now=new Date().toISOString(),updated=db.prepare("UPDATE recipients SET primary_asset=?,primary_network=?,primary_address=?,primary_memo=?,backup_network=?,backup_address=?,fallback_consent=?,preference_status='confirmed',confirmed_at=?,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=? AND archived=0")
      .run(input.primaryAsset,input.primaryNetwork,input.primaryAddress,input.primaryMemo??null,input.backupNetwork??null,input.backupAddress??null,Number(input.fallbackConsent),now,now,recipient.id,userId,input.expectedVersion);
    if(!updated.changes)throw new ApiError(409,"Your preferences changed. Refresh before confirming.","RECIPIENT_VERSION_CHANGED");
    saveVersion(getRecipient(recipient.organization_id,recipient.id),userId);
    audit(userId,recipient.organization_id,"recipient.preferences_confirmed",recipient.id,{version:input.expectedVersion+1,fallbackConsent:input.fallbackConsent});
  });
  return c.json({recipient:getRecipient(recipient.organization_id,recipient.id)});
});
recipientWorkspaceRoutes.post("/invoices",async c=>c.json({request:submitInvoice(c.get("userId"),invoiceInput.parse(await c.req.json()))},201));

export const companyInvoiceIntakeRoutes=new Hono<AppEnv>();
companyInvoiceIntakeRoutes.use("*",requireUser);
companyInvoiceIntakeRoutes.get("/",requireOrganization("payments:read"),c=>{const page=Page.parse(c.req.query());return c.json(companyRequestPage(c.get("access"),page.page,page.pageSize));});
companyInvoiceIntakeRoutes.post("/:id/prepare",requireOrganization("payments:prepare"),async c=>c.json(prepareInvoiceRequest(c.get("access"),c.req.param("id"),reviewInput.parse(await c.req.json()))));
