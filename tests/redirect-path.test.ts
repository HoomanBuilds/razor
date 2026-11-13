import assert from "node:assert/strict";
import { test } from "node:test";
import { localRedirect } from "../src/lib/redirect-path";

test("sign-in returns to internal company and personal records without crossing origins",()=>{
  for(const unsafe of ["https://other.example/path","//other.example/path","/\\other.example/path","/\n/other.example",null,42])assert.equal(localRedirect(unsafe),"/");
  assert.equal(localRedirect("/?company=one&section=payments&payment=two"),"/?company=one&section=payments&payment=two");
  assert.equal(localRedirect("/receive?paymentId=private-record"),"/receive?paymentId=private-record");
  assert.equal(localRedirect("invalid","/account"),"/account");
});
