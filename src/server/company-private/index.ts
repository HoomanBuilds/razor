import { Hono } from "hono";
import type { AppEnv } from "../context";
import { importCompanyInvoice } from "./service";

export const companyPrivateRoutes = new Hono<AppEnv>();
companyPrivateRoutes.post("/reviewed-invoices", async c => {
  const result = importCompanyInvoice(c.get("access"), await c.req.json());
  return c.json(result, result.created ? 201 : 200);
});
