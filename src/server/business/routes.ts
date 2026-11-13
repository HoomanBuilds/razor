import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requirePermission } from "../context";
import { rows } from "../db";
import { createBill, createPayrollRun, disputeBill, getPayrollRun, listBills, listPayrollRuns, report } from "./service";
import { acceptBillMilestone, addBillInstallment, getBillTerms, resolveBillDispute, setBillTerms } from "./bill-terms";
import { approveBillBatch, approveReviewedPayrollRun } from "../payment-management/service";

const money = z.string().regex(/^\d+$/);
const billInput = z.object({ recipientId: z.string().min(1), reference: z.string().trim().min(1).max(120), title: z.string().trim().min(1).max(240), amount: money, maxFee: money.optional(), dueDate: z.string().datetime().optional(), lineItems: z.array(z.unknown()).max(100).optional(), evidence: z.string().max(5000).optional(), documentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), projectReference: z.string().trim().max(120).optional(), costCenterReference: z.string().trim().max(120).optional() });
const payrollInput = z.object({ reference: z.string().trim().min(1).max(120), periodStart: z.string().date(), periodEnd: z.string().date(), scheduledFor: z.string().datetime().optional(), items: z.array(z.object({ recipientId: z.string().min(1), amount: money, maxFee: money.optional(), baseAmount: money.optional(), bonusAmount: money.optional(), adjustmentAmount: z.string().regex(/^-?\d+$/).optional(), note: z.string().max(500).optional() })).min(1).max(1000) });

export const businessRoutes = new Hono<AppEnv>();
businessRoutes.get("/bills", (c) => c.json({ bills: listBills(c.get("access")) }));
businessRoutes.post("/bills", async (c) => c.json({ bill: createBill(c.get("access"), billInput.parse(await c.req.json())) }, 201));
businessRoutes.post("/bills/:id/approve", async (c) => c.json({ payment: approveBillBatch(c.get("access"), [c.req.param("id")], z.object({ reviewToken: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await c.req.json()).reviewToken).payments[0] }));
businessRoutes.post("/bills/:id/dispute", async (c) => c.json(disputeBill(c.get("access"), c.req.param("id"), z.object({ reason: z.string().min(3).max(2000) }).parse(await c.req.json()).reason)));
businessRoutes.get("/bills/:id/terms", (c) => c.json(getBillTerms(c.get("access"), c.req.param("id"))));
businessRoutes.post("/bills/:id/terms", async (c) => c.json(setBillTerms(c.get("access"), c.req.param("id"), z.object({ paymentAmount: money, maxFee: money, requiresAcceptance: z.boolean() }).parse(await c.req.json()))));
businessRoutes.post("/bills/:id/accept", async (c) => c.json(acceptBillMilestone(c.get("access"), c.req.param("id"), z.object({ evidence: z.string().trim().min(3).max(5000) }).parse(await c.req.json()).evidence)));
businessRoutes.post("/bills/:id/resolve", async (c) => c.json(resolveBillDispute(c.get("access"), c.req.param("id"), z.object({ resolution: z.string().trim().min(3).max(5000) }).parse(await c.req.json()).resolution)));
businessRoutes.post("/bills/:id/installments", async (c) => c.json(addBillInstallment(c.get("access"), c.req.param("id"), z.object({ amount: money, maxFee: money }).parse(await c.req.json()))));
businessRoutes.get("/payroll", (c) => c.json({ runs: listPayrollRuns(c.get("access")) }));
businessRoutes.post("/payroll", async (c) => c.json({ run: createPayrollRun(c.get("access"), payrollInput.parse(await c.req.json())) }, 201));
businessRoutes.get("/payroll/:id", (c) => c.json({ run: getPayrollRun(c.get("access"), c.req.param("id")) }));
businessRoutes.post("/payroll/:id/approve", async (c) => c.json({ run: approveReviewedPayrollRun(c.get("access"), c.req.param("id"), z.object({ reviewToken: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await c.req.json()).reviewToken) }));
businessRoutes.get("/reports/export", (c) => { c.header("Content-Type", "text/csv; charset=utf-8"); c.header("Content-Disposition", 'attachment; filename="razor-payments.csv"'); return c.body(report(c.get("access"))); });
businessRoutes.get("/activity", (c) => { const access = c.get("access"); requirePermission(access, "company:read"); return c.json({ activity: rows("SELECT * FROM activity WHERE organization_id = ? ORDER BY created_at DESC LIMIT 200", access.organizationId) }); });
