import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ApiError, type AccessContext } from "../src/server/context";
import { getDb, row, rows } from "../src/server/db";
import { decrypt, encrypt } from "../src/server/identity/crypto";
import { deriveSharedCompanyId } from "../src/server/payments/near";
import { getTreasury } from "../src/server/payments/service";
import { NATIVE_USDC } from "../src/lib/native-usdc";
import { beginDistribution, beginOwnClaim, createDistribution, discardDistribution, distributionLocalReserve, finishOwnClaimWallet, inspectDistribution, inspectOwnClaim, listDistributions, monitorDistributions, ownDistributionClaims, prepareDistribution, prepareDistributionControl, prepareOwnClaim, recordOwnClaimWalletReference, releaseUnsignedDistribution } from "../src/server/distributions/service";
import { assertChainTerms, distributionInput, distributionTermsHash, hash, sumEntitlements, type ChainDistribution, type DistributionRow, type FrozenPlan } from "../src/server/distributions/model";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "d6".repeat(32);
process.env.NEAR_TREASURY_CODE_HASH = "1".repeat(32);
const permissions = ["company:read", "company:manage", "payments:read", "payments:prepare", "payments:approve", "payments:execute", "recipients:read"];
const code = (wanted: string) => (error: unknown) => error instanceof ApiError && error.code === wanted;
function fixture() {
  const id = randomUUID(), userId = randomUUID(), recipientId = randomUUID(), recipientUser = randomUUID(), role = randomUUID(), db = getDb(), stamp = new Date().toISOString();
  const ownerAccount = `owner-${id.slice(0, 8)}.testnet`, address = `receiver-${id.slice(0, 8)}.testnet`;
  for (const [user, name] of [[userId, "Owner"], [recipientUser, "Payee"]]) db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(user, name, stamp);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, "Claim company", userId, stamp, stamp);
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,?, ?,1,?)").run(role, id, "Owner", JSON.stringify(permissions), stamp);
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,status,created_at) VALUES(?,?,?, 'active',?)").run(id, userId, role, stamp);
  db.prepare("INSERT INTO recipients(id,organization_id,user_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,?,'employee','USDC','near',?,'confirmed',?,?,?)").run(recipientId, id, recipientUser, encrypt("Private employee"), address, stamp, stamp, stamp);
  for (const [user, wallet] of [[userId, ownerAccount], [recipientUser, address]]) db.prepare("INSERT INTO linked_wallets(id,user_id,family,address,network,created_at) VALUES(?,?,'near',?,'testnet',?)").run(randomUUID(), user, wallet, stamp);
  db.prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,architecture,company_id,created_at) VALUES(?,'treasury.testnet','testnet','usdc.testnet','shared_v1',?,?)").run(id, deriveSharedCompanyId(id, ownerAccount), stamp);
  db.prepare("INSERT INTO treasury_balances(organization_id,balance,reserved,updated_at) VALUES(?,'100000000','0',?)").run(id, stamp);
  return { access: { userId, organizationId: id, permissions } satisfies AccessContext, recipientId, recipientUser, ownerAccount, address, role };
}
function input(f: ReturnType<typeof fixture>, amount = "20000000") { return { reference: `pool-${randomUUID()}`, deadline: new Date(Date.now() + 86400000).toISOString(), requestKey: randomUUID(), items: [{ recipientId: f.recipientId, amount }] }; }
function saved(f: ReturnType<typeof fixture>, id: string) { return row<DistributionRow>("SELECT * FROM claim_distributions WHERE id=? AND organization_id=?", id, f.access.organizationId)!; }
function frozen(f: ReturnType<typeof fixture>, id: string) { return JSON.parse(decrypt(saved(f, id).plan_ciphertext!)) as FrozenPlan; }
function chainFor(plan: FrozenPlan): ChainDistribution { return { id: plan.id, reference: plan.reference, network: plan.network, token_contract: plan.token, deadline_ms: plan.deadlineMs, total: plan.total,
  unclaimed: plan.total, pending: "0", paid: "0", reclaimed: "0", policy_version: plan.policyVersion, terms_hash: distributionTermsHash(plan), required_approvals: plan.requiredApprovals, approvals: [plan.owner], status: "active",
  claims: plan.allocations.map(({ destination, ...allocation }) => ({ allocation, destination, status: "ready", nonce: "0", sent_day: "0" })) }; }
interface Remote { chain?: ChainDistribution | null; voided?: boolean; registered?: boolean; version?: string; recipientChanged?: boolean; missing?: boolean; afterRecipients?: () => void }
async function rpc<T>(f: ReturnType<typeof fixture>, remote: Remote, action: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string), method = request.params?.method_name;
    const args = request.params?.args_base64 ? JSON.parse(Buffer.from(request.params.args_base64, "base64").toString()) : {};
    let value: unknown = null;
    if (request.params?.request_type === "view_account") return Response.json({ result: { code_hash: process.env.NEAR_TREASURY_CODE_HASH } });
    const profile = { version: remote.recipientChanged ? "8" : "7", active: true, primary: { network: "near", asset_id: "nep141:usdc.testnet", address: remote.recipientChanged ? "other.testnet" : f.address } };
    if (method === "get_config") value = { owner_id: f.ownerAccount, paused: false, policy_version: remote.version ?? "1", per_payment_limit: "100000000", daily_limit: "200000000", approvers: [], approval_tiers: [{ required_approvals: 1 }] };
    if (method === "get_distribution_recipients") { value = args.recipient_ids.map(() => remote.missing ? null : profile); remote.afterRecipients?.(); }
    if (method === "get_recipient") value = profile;
    if (method === "get_distribution") value = remote.chain ?? null;
    if (method === "distribution_voided") value = remote.voided ?? false;
    if (method === "get_storage") value = { storage_credit: "1000000000000000000000000", storage_used: "1000000000000000000000", storage_available: "999000000000000000000000" };
    if (method === "get_balance") value = { balance: (100000000n - BigInt(remote.chain?.paid ?? "0") - BigInt(remote.chain?.pending ?? "0")).toString(), reserved: remote.chain?.unclaimed ?? "0", available: "0", in_flight: remote.chain?.pending ?? "0", confirmed_at_ms: String(Date.now()) };
    if (method === "storage_balance_of") value = remote.registered === false ? null : { total: "1250000000000000000000" };
    if (method === "storage_balance_bounds") value = { min: "1250000000000000000000" };
    return Response.json({ result: { result: [...Buffer.from(JSON.stringify(value))] } });
  };
  try { return await action(); } finally { globalThis.fetch = original; }
}

test("distribution amounts are exact, overflow bounded and each retry binds the same complete terms", () => {
  const f = fixture(), data = input(f), first = createDistribution(f.access, data);
  assert.equal(createDistribution(f.access, data).id, first.id);
  assert.throws(() => createDistribution(f.access, { ...data, items: [{ recipientId: f.recipientId, amount: "20000001" }] }), code("DISTRIBUTION_IDEMPOTENCY_CONFLICT"));
  assert.equal(sumEntitlements([{ amount: "1" }, { amount: "99999999999999999999999999999999999" }]), "100000000000000000000000000000000000");
  assert.throws(() => sumEntitlements([{ amount: ((1n << 128n) - 1n).toString() }, { amount: "1" }]), code("DISTRIBUTION_AMOUNT_INVALID"));
  for (const amount of ["0", "-1", "1.1", "01", (1n << 128n).toString()]) assert.equal(distributionInput.safeParse({ ...data, items: [{ recipientId: f.recipientId, amount }] }).success, false);
  for (const reference of ["line\nbreak", "界".repeat(60), "bad\u0080reference"]) assert.equal(distributionInput.safeParse({ ...data, reference }).success, false);
  assert.throws(() => createDistribution(f.access, { ...input(f), items: [data.items[0], data.items[0]] }), code("DISTRIBUTION_INPUT_INVALID"));
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM payments WHERE organization_id=?").get(f.access.organizationId)!.n, 0);
  assert.equal(saved(f, first.id).local_reserved, "0");
});

test("company and recipient projections cannot expose another company or another person's entitlement", async () => {
  const f = fixture(), other = fixture(), first = createDistribution(f.access, input(f));
  assert.throws(() => createDistribution(f.access, { ...input(f), items: [{ recipientId: other.recipientId, amount: "1" }] }), code("RECIPIENT_NOT_FOUND"));
  assert.throws(() => listDistributions({ ...f.access, userId: other.access.userId }), code("COMPANY_ACCESS_DENIED"));
  await assert.rejects(() => inspectDistribution(other.access, first.id), code("DISTRIBUTION_NOT_FOUND"));
  assert.equal(ownDistributionClaims(f.recipientUser).total, 0);
  await rpc(f, {}, async () => { await prepareDistribution(f.access, first.id); });
  await rpc(f, { chain: chainFor(frozen(f, first.id)) }, async () => { await inspectDistribution(f.access, first.id); });
  const own = ownDistributionClaims(f.recipientUser); assert.equal(own.total, 1); assert.equal(own.claims[0].amount, "20000000");
  assert.equal(ownDistributionClaims(other.recipientUser).total, 0);
  await assert.rejects(() => inspectOwnClaim(other.recipientUser, own.claims[0].id), code("DISTRIBUTION_CLAIM_NOT_FOUND"));
  assert.ok(!JSON.stringify(own).includes(f.access.userId));
  assert.notEqual(saved(f, first.id).payload_ciphertext, JSON.stringify(first.payload));
  const discarded = createDistribution(f.access, input(f)); discardDistribution(f.access, discarded.id); assert.equal(saved(f, discarded.id).stage, "voided");
});

test("native profile synchronization is separate, bounded and creates no funding fence", async () => {
  const f = fixture(), draft = createDistribution(f.access, input(f));
  await rpc(f, { missing: true }, async () => {
    const preview = await prepareDistribution(f.access, draft.id); assert.equal(preview.phase, "recipients"); assert.equal(preview.walletActions.length, 1);
    assert.equal(preview.walletActions[0].actions[0].params.methodName, "set_recipient");
    assert.equal(preview.walletActions[0].actions[0].params.deposit, "1");
    assert.equal(saved(f, draft.id).local_reserved, "0");
  });
});

test("concurrent distribution review and existing payment reservations cannot spend the same local cash", async () => {
  const f = fixture(); getDb().prepare("UPDATE treasury_balances SET reserved='20000000' WHERE organization_id=?").run(f.access.organizationId);
  const first = createDistribution(f.access, input(f, "60000000")), second = createDistribution(f.access, input(f, "30000000"));
  await rpc(f, {}, async () => {
    const result = await Promise.allSettled([prepareDistribution(f.access, first.id), prepareDistribution(f.access, second.id)]);
    assert.equal(result.filter(value => value.status === "fulfilled").length, 1);
    const failure = result.find(value => value.status === "rejected") as PromiseRejectedResult; assert.equal(failure.reason.code, "DISTRIBUTION_UNFUNDED");
    assert.ok(BigInt(distributionLocalReserve(f.access.organizationId)) <= 80000000n);
  });
});

test("a wallet fence persists through uncertainty and only authoritative funding or void removes it", async () => {
  const f = fixture(), draft = createDistribution(f.access, input(f)), remote: Remote = {};
  await rpc(f, remote, async () => {
    const preview = await prepareDistribution(f.access, draft.id); assert.equal(preview.phase, "fund");
    await beginDistribution(f.access, draft.id, { planHash: preview.planHash!, signerAccount: f.ownerAccount });
    assert.equal(saved(f, draft.id).stage, "signing");
    await inspectDistribution(f.access, draft.id); assert.equal(saved(f, draft.id).local_reserved, "20000000");
    await assert.rejects(() => prepareDistribution(f.access, draft.id), code("DISTRIBUTION_CREATION_HELD"));
    const cancel = await prepareDistributionControl(f.access, draft.id, "void"); assert.equal(cancel.walletActions[0].actions[0].params.methodName, "void_distribution");
    remote.voided = true; await inspectDistribution(f.access, draft.id); assert.equal(saved(f, draft.id).local_reserved, "0"); assert.equal(saved(f, draft.id).stage, "voided");
  });
});

test("observed chain backing replaces the local fence and policy/profile changes hold fixed claims", async () => {
  const f = fixture(), draft = createDistribution(f.access, input(f)), remote: Remote = {};
  await rpc(f, remote, async () => {
    await prepareDistribution(f.access, draft.id); const committed = frozen(f, draft.id); remote.chain = chainFor(committed);
    await inspectDistribution(f.access, draft.id); assert.equal(saved(f, draft.id).local_reserved, "0");
    assert.equal(getTreasury(f.access).reserved, "20000000"); assert.equal(getTreasury(f.access).available, "80000000");
    const claimId = committed.allocations[0].claim_id;
    remote.version = "2"; assert.ok((await inspectOwnClaim(f.recipientUser, claimId)).problems.some(value => value.includes("policy")));
    await assert.rejects(() => prepareOwnClaim(f.recipientUser, claimId), code("DISTRIBUTION_CLAIM_HELD"));
    remote.version = "1"; remote.recipientChanged = true; assert.ok((await inspectDistribution(f.access, draft.id)).heldClaims.includes(claimId));
    await assert.rejects(() => prepareOwnClaim(f.recipientUser, claimId), code("DISTRIBUTION_CLAIM_HELD"));
  });
});

test("claim planning pays the fixed entitlement and exposes actual token storage without redirect authority", async () => {
  const f = fixture(), draft = createDistribution(f.access, input(f)), remote: Remote = { registered: false };
  await rpc(f, remote, async () => {
    await prepareDistribution(f.access, draft.id); const committed = frozen(f, draft.id); remote.chain = chainFor(committed);
    await inspectDistribution(f.access, draft.id);
    const claimId = committed.allocations[0].claim_id, registration = await prepareOwnClaim(f.recipientUser, claimId);
    assert.equal(registration.phase, "registration"); assert.equal(registration.walletActions.length, 1); assert.equal(registration.registrationDeposit, "1250000000000000000000");
    assert.deepEqual(registration.walletActions[0].actions[0].params.args, { account_id: f.address, registration_only: true });
    await beginOwnClaim(f.recipientUser, claimId, { planHash: registration.planHash, signerAccount: f.address, reviewGeneration: registration.reviewGeneration });
    assert.equal(ownDistributionClaims(f.recipientUser).claims[0].sourceUnknown, false);
    finishOwnClaimWallet(f.recipientUser, claimId, registration.reviewGeneration);
    remote.registered = true; const preview = await prepareOwnClaim(f.recipientUser, claimId);
    assert.equal(preview.phase, "claim"); assert.equal(preview.walletActions.length, 1);
    const call = preview.walletActions[0].actions[0].params; assert.equal(call.methodName, "claim_distribution");
    assert.ok(call.args && typeof call.args === "object");
    assert.ok(!("receiver_id" in call.args)); assert.ok(!("amount" in call.args));
    await beginOwnClaim(f.recipientUser, claimId, { planHash: preview.planHash, signerAccount: f.address, reviewGeneration: preview.reviewGeneration });
    assert.equal(ownDistributionClaims(f.recipientUser).claims[0].sourceUnknown, true);
    finishOwnClaimWallet(f.recipientUser, claimId, preview.reviewGeneration);
    remote.chain.claims[0].status = "pending"; remote.chain.claims[0].nonce = "1"; remote.chain.unclaimed = "0"; remote.chain.pending = remote.chain.total;
    await assert.rejects(() => prepareOwnClaim(f.recipientUser, claimId), code("DISTRIBUTION_CLAIM_HELD"));
    remote.chain.claims[0].status = "paid"; remote.chain.pending = "0"; remote.chain.paid = remote.chain.total; remote.chain.status = "complete";
    await inspectOwnClaim(f.recipientUser, claimId); assert.equal(ownDistributionClaims(f.recipientUser).claims[0].sourceUnknown, false);
  });
});

test("revoked preparation access during RPC cannot commit a distribution funding fence", async () => {
  const f = fixture(), draft = createDistribution(f.access, input(f));
  await rpc(f, { afterRecipients: () => getDb().prepare("UPDATE memberships SET status='removed' WHERE organization_id=? AND user_id=?").run(f.access.organizationId, f.access.userId) }, async () => {
    await assert.rejects(() => prepareDistribution(f.access, draft.id), code("COMPANY_ACCESS_DENIED"));
    assert.equal(saved(f, draft.id).local_reserved, "0");
  });
});

test("allocation commitments reject substitutions, nonconserved totals and depend on deployment identity", async () => {
  const f = fixture(), draft = createDistribution(f.access, input(f));
  await rpc(f, {}, async () => {
    await prepareDistribution(f.access, draft.id); const committed = frozen(f, draft.id), chain = chainFor(committed);
    assertChainTerms(chain, committed);
    assert.notEqual(distributionTermsHash(committed), distributionTermsHash({ ...committed, network: "mainnet" }));
    assert.notEqual(distributionTermsHash(committed), distributionTermsHash({ ...committed, treasury: "other.testnet" }));
    for (const changed of [{ ...chain, total: "1" }, { ...chain, pending: "1" }, { ...chain, terms_hash: hash("other") }, { ...chain, claims: [{ ...chain.claims[0], destination: "attacker.testnet" }] }]) assert.throws(() => assertChainTerms(changed, committed), (error: unknown) => error instanceof ApiError);
  });
});

test("bounded monitoring is company scoped and reported wallet hashes cannot establish delivery", async () => {
  const f = fixture(), other = fixture(), draft = createDistribution(f.access, input(f)), otherDraft = createDistribution(other.access, input(other));
  await rpc(other, {}, () => prepareDistribution(other.access, otherDraft.id));
  const remote: Remote = {};
  await rpc(f, remote, async () => {
    await prepareDistribution(f.access, draft.id); remote.chain = chainFor(frozen(f, draft.id));
    assert.deepEqual(await monitorDistributions({ organizationId: f.access.organizationId, maxPools: 1 }), { processed: 1, held: 0 });
    assert.equal(saved(other, otherDraft.id).stage, "review"); assert.equal(saved(other, otherDraft.id).local_reserved, "20000000");
    const claimId = remote.chain.claims[0].allocation.claim_id;
    const review = await prepareOwnClaim(f.recipientUser, claimId);
    await beginOwnClaim(f.recipientUser, claimId, { planHash: review.planHash, reviewGeneration: review.reviewGeneration, signerAccount: f.address });
    assert.deepEqual(recordOwnClaimWalletReference(f.recipientUser, claimId, "1".repeat(32), review.reviewGeneration), { recorded: true, verified: false });
    assert.equal(saved(f, draft.id).paid_amount, "0"); assert.equal(saved(f, draft.id).pending_amount, "0");
    assert.throws(() => recordOwnClaimWalletReference(other.recipientUser, claimId, "1".repeat(32), review.reviewGeneration), code("DISTRIBUTION_CLAIM_NOT_FOUND"));
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    assert.deepEqual(await monitorDistributions({ organizationId: f.access.organizationId, maxPools: 1 }), { processed: 0, held: 1 });
    assert.equal(saved(f, draft.id).chain_reserved, "20000000"); assert.ok(saved(f, draft.id).last_error);
  } finally { globalThis.fetch = original; }
});


test("unsigned review release is free while an initiated wallet creation cannot be unfenced", async () => {
  const f = fixture(), draft = createDistribution(f.access, input(f));
  await rpc(f, {}, async () => {
    const preview = await prepareDistribution(f.access, draft.id);
    assert.deepEqual(await releaseUnsignedDistribution(f.access, draft.id), { cancelled: true, onchainTransactionRequired: false });
    assert.equal(saved(f, draft.id).local_reserved, "0"); assert.equal(saved(f, draft.id).stage, "voided");
    await assert.rejects(() => beginDistribution(f.access, draft.id, { planHash: preview.planHash!, signerAccount: f.ownerAccount }), code("DISTRIBUTION_CREATION_HELD"));
    const pending = createDistribution(f.access, input(f)), prepared = await prepareDistribution(f.access, pending.id);
    await beginDistribution(f.access, pending.id, { planHash: prepared.planHash!, signerAccount: f.ownerAccount });
    await assert.rejects(() => releaseUnsignedDistribution(f.access, pending.id), code("DISTRIBUTION_CREATION_HELD"));
    assert.equal(saved(f, pending.id).local_reserved, "20000000");
  });
});

test("an unfunded draft can be discarded without a configured treasury or a wallet action", () => {
  const f = fixture(); getDb().prepare("DELETE FROM treasury_config WHERE organization_id=?").run(f.access.organizationId);
  getDb().prepare("UPDATE recipients SET primary_asset=? WHERE id=?").run(`nep141:${NATIVE_USDC.near}`, f.recipientId);
  const draft = createDistribution(f.access, input(f));
  assert.equal(listDistributions(f.access).configured, false);
  assert.deepEqual(discardDistribution(f.access, draft.id), { cancelled: true });
  assert.equal(saved(f, draft.id).stage, "voided");
  assert.equal(saved(f, draft.id).local_reserved, "0");
});


test("rejected wallet dialogs can explicitly retry only the same ready claim and stale tabs cannot clear a newer lease", async () => {
  const f = fixture(), draft = createDistribution(f.access, input(f)), remote: Remote = {};
  await rpc(f, remote, async () => {
    await prepareDistribution(f.access, draft.id); remote.chain = chainFor(frozen(f, draft.id)); await inspectDistribution(f.access, draft.id);
    const claimId = remote.chain.claims[0].allocation.claim_id;
    const first = await prepareOwnClaim(f.recipientUser, claimId);
    await beginOwnClaim(f.recipientUser, claimId, { planHash: first.planHash, reviewGeneration: first.reviewGeneration, signerAccount: f.address });
    await assert.rejects(() => prepareOwnClaim(f.recipientUser, claimId), code("DISTRIBUTION_WALLET_BUSY"));
    assert.equal(finishOwnClaimWallet(f.recipientUser, claimId, first.reviewGeneration).released, true);
    assert.equal(ownDistributionClaims(f.recipientUser).claims[0].sourceUnknown, true);
    const retry = await prepareOwnClaim(f.recipientUser, claimId);
    assert.equal(retry.retrySameClaim, true); assert.notEqual(retry.reviewGeneration, first.reviewGeneration);
    assert.deepEqual(retry.walletActions, first.walletActions);
    await assert.rejects(() => beginOwnClaim(f.recipientUser, claimId, { planHash: retry.planHash, reviewGeneration: retry.reviewGeneration, signerAccount: f.address }), code("DISTRIBUTION_SAME_CLAIM_REVIEW_REQUIRED"));
    await beginOwnClaim(f.recipientUser, claimId, { planHash: retry.planHash, reviewGeneration: retry.reviewGeneration, signerAccount: f.address, retrySameClaim: true });
    assert.equal(finishOwnClaimWallet(f.recipientUser, claimId, first.reviewGeneration).released, false);
    assert.equal(row<{ wallet_lease_generation: string }>("SELECT wallet_lease_generation FROM claim_distribution_allocations WHERE id=?", claimId)!.wallet_lease_generation, retry.reviewGeneration);
    await assert.rejects(() => beginOwnClaim(f.recipientUser, claimId, { planHash: first.planHash, reviewGeneration: first.reviewGeneration, signerAccount: f.address, retrySameClaim: true }), code("DISTRIBUTION_REVIEW_CHANGED"));
    finishOwnClaimWallet(f.recipientUser, claimId, retry.reviewGeneration);
    remote.chain.claims[0].status = "pending"; remote.chain.claims[0].nonce = "1"; remote.chain.pending = remote.chain.total; remote.chain.unclaimed = "0";
    await assert.rejects(() => prepareOwnClaim(f.recipientUser, claimId), code("DISTRIBUTION_CLAIM_HELD"));
    remote.chain.claims[0].status = "paid"; remote.chain.status = "complete"; remote.chain.pending = "0"; remote.chain.paid = remote.chain.total;
    await assert.rejects(() => prepareOwnClaim(f.recipientUser, claimId), code("DISTRIBUTION_CLAIM_HELD"));
    assert.equal(remote.chain.claims[0].allocation.claim_id, claimId);
  });
});
