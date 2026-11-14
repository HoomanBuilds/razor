import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HelpCenter } from "../src/components/help-center";
import { SupportInbox } from "../src/components/workspace/support";

test("public guides and authenticated support controls render without attachments or staffing promises",()=>{
 const guides=renderToStaticMarkup(createElement(HelpCenter));
 assert.ok(guides.includes('type="search"'));assert.ok(guides.includes("Connect QuickBooks Online or Xero"));assert.ok(guides.includes("/?section=payroll"));
 const inbox=renderToStaticMarkup(createElement(SupportInbox,{organizationId:"company-reference"}));
 for(const label of ["Record private support case","Payment ID (optional)","Funding leg ID (optional)","Previous cases","Next cases"])assert.ok(inbox.includes(label));
 assert.ok(inbox.includes("does not promise a staff response"));assert.ok(!inbox.includes('type="file"'));assert.ok(inbox.includes("flex-wrap"));
});
