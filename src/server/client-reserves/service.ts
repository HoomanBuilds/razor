import { createHash, randomUUID } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt, hashToken } from "../identity/crypto";
import { atomic } from "../../lib/money";
import { approvePayment, getPayment, getTreasury } from "../payments/service";
import { paymentTermsHash, reservePositions, type ReservePosition, type ReserveRecord } from "./accounting";

interface ReserveEvent { id: string; reserve_id: string; actor_id: string; action: string; request_key: string; input_fingerprint: string; details_ciphertext: string; created_at: string }
const now = () => new Date().toISOString();
const fingerprint = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
function manage(access: AccessContext) { requirePermission(access, "payments:approve"); requirePermission(access, "payments:read"); }
function key(value: string) { if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new ApiError(422, "Use a stable action identifier", "RESERVE_KEY_INVALID"); return hashToken(value); }
function record(access: AccessContext, reserveId: string) {
  const result = row<ReserveRecord>("SELECT * FROM client_reserves WHERE id=? AND organization_id=?", reserveId, access.organizationId);
  if (!result) throw new ApiError(404, "Client earmark not found", "CLIENT_RESERVE_NOT_FOUND");
  return result;
}
function event(access: AccessContext, requestKey: string, reserveId: string, action: string, inputFingerprint: string) {
  const old = row<ReserveEvent>("SELECT * FROM client_reserve_events WHERE organization_id=? AND request_key=?", access.organizationId, requestKey);
  if (old && (old.reserve_id !== reserveId || old.action !== action || old.input_fingerprint !== inputFingerprint)) throw new ApiError(409, "This action identifier already has different terms", "RESERVE_IDEMPOTENCY_CONFLICT");
  return old;
}
function audit(access: AccessContext, reserveId: string, action: string, requestKey: string, inputFingerprint: string, details: unknown) {
  getDb().prepare("INSERT INTO client_reserve_events(id,organization_id,reserve_id,actor_id,action,request_key,input_fingerprint,details_ciphertext,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(randomUUID(), access.organizationId, reserveId, access.userId, action, requestKey, inputFingerprint, encrypt(JSON.stringify(details)), now());
}
function view(position: ReservePosition) {
  const { reserve, payment } = position;
  return { id: reserve.id, amount: reserve.amount, purpose: decrypt(reserve.purpose_ciphertext), clientReference: reserve.client_reference_ciphertext ? decrypt(reserve.client_reference_ciphertext) : null,
    activePaymentId: position.activePaymentId, fundingId: reserve.funding_id, paymentId: reserve.payment_id, paymentReference: payment?.reference ?? null, paymentStatus: payment?.status ?? null,
    state: position.state, disposition: reserve.state, outstandingPrincipal: position.outstanding.toString(), clientReserved: position.clientReserved.toString(), paymentCovered: position.paymentCovered.toString(), principalInFlight: position.inFlight.toString(),
    releaseReason: reserve.release_reason_ciphertext ? decrypt(reserve.release_reason_ciphertext) : null, createdAt: reserve.created_at, allocatedAt: reserve.allocated_at, releasedAt: reserve.released_at };
}

export function getClientReserve(access: AccessContext, reserveId: string) {
  requirePermission(access, "payments:read"); record(access, reserveId);
  const position = reservePositions(access.organizationId).find((item) => item.reserve.id === reserveId)!;
  const events = rows<ReserveEvent>("SELECT * FROM client_reserve_events WHERE organization_id=? AND reserve_id=? ORDER BY created_at,id", access.organizationId, reserveId)
    .map(({ details_ciphertext, request_key: _key, input_fingerprint: _fingerprint, ...item }) => ({ ...item, details: JSON.parse(decrypt(details_ciphertext)) }));
  return { ...view(position), events };
}
export function listClientReserves(access: AccessContext) {
  requirePermission(access, "payments:read");
  return { reserves: reservePositions(access.organizationId).map(view), treasury: getTreasury(access), canManage: access.permissions.includes("payments:approve") };
}

function fundingCredit(access: AccessContext, fundingId: string) {
  const leg = row<{ status: string; credited_amount: string; recipient_address: string }>("SELECT status,credited_amount,recipient_address FROM funding_legs WHERE id=? AND organization_id=?", fundingId, access.organizationId);
  const config = row<{ near_account_id: string; network: string; token_contract: string }>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  if (!leg || !config || leg.status !== "confirmed" || leg.recipient_address !== config.near_account_id) throw new ApiError(409, "Choose a confirmed funding receipt in this company's treasury", "CLIENT_FUNDING_UNCONFIRMED");
  const proved = rows<{ amount: string }>("SELECT amount FROM funding_credit_receipts WHERE funding_id=? AND organization_id=? AND network=? AND token_contract=?", fundingId, access.organizationId, config.network, config.token_contract).reduce((sum, receipt) => sum + atomic(receipt.amount), 0n);
  if (proved === 0n || proved !== atomic(leg.credited_amount, true)) throw new ApiError(409, "Final token receipts must confirm this funding credit first", "CLIENT_FUNDING_UNCONFIRMED");
  return proved;
}

export function createClientReserve(access: AccessContext, input: { idempotencyKey: string; amount: string; purpose: string; clientReference?: string; fundingId?: string; paymentId?: string }) {
  manage(access); const requestKey = key(input.idempotencyKey);
  let amount: string;
  try { amount = atomic(input.amount).toString(); } catch { throw new ApiError(422, "Enter a positive client principal in microUSDC", "INVALID_AMOUNT"); }
  if (!input.purpose.trim() || input.purpose.length > 500) throw new ApiError(422, "Record the earmark purpose in up to 500 characters", "CLIENT_PURPOSE_INVALID");
  const terms = { amount, purpose: input.purpose.trim(), clientReference: input.clientReference?.trim() || null, fundingId: input.fundingId ?? null, paymentId: input.paymentId ?? null };
  const hash = fingerprint(terms);
  return transaction(() => {
    const old = row<ReserveRecord>("SELECT * FROM client_reserves WHERE organization_id=? AND request_key=?", access.organizationId, requestKey);
    if (old) {
      if (old.creation_fingerprint !== hash) throw new ApiError(409, "This earmark identifier already has different terms", "RESERVE_IDEMPOTENCY_CONFLICT");
      return getClientReserve(access, old.id);
    }
    if (row("SELECT id FROM client_reserve_events WHERE organization_id=? AND request_key=?", access.organizationId, requestKey)) throw new ApiError(409, "This action identifier was already used", "RESERVE_IDEMPOTENCY_CONFLICT");
    const treasury = getTreasury(access);
    if (!treasury.config || !treasury.lastSyncedAt || atomic(treasury.available, true) < atomic(amount)) throw new ApiError(409, "Sync and fund enough unreserved company cash before creating this earmark", "CLIENT_RESERVE_UNFUNDED");
    const payment = terms.paymentId ? getPayment(access, terms.paymentId) : null;
    if (payment && (payment.amount !== amount || ["paid", "partially_paid"].includes(payment.status))) throw new ApiError(409, "Link one unpaid obligation with exactly the same principal", "CLIENT_PAYMENT_MISMATCH");
    if (payment && row("SELECT id FROM client_reserves WHERE payment_id=? AND state!='released'", payment.id)) throw new ApiError(409, "This principal already belongs to another active client earmark", "CLIENT_PAYMENT_ALREADY_LINKED");
    if (terms.fundingId) {
      const confirmed = fundingCredit(access, terms.fundingId);
      const tagged = rows<{ amount: string }>("SELECT amount FROM client_reserves WHERE organization_id=? AND funding_id=? AND state!='released'", access.organizationId, terms.fundingId).reduce((sum, reserve) => sum + atomic(reserve.amount), 0n);
      if (tagged + atomic(amount) > confirmed) throw new ApiError(409, "This funding receipt's principal is already earmarked", "CLIENT_FUNDING_ALREADY_ASSIGNED");
    }
    const id = randomUUID(), createdAt = now();
    getDb().prepare("INSERT INTO client_reserves(id,organization_id,request_key,creation_fingerprint,amount,purpose_ciphertext,client_reference_ciphertext,funding_id,payment_id,payment_terms_hash,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, access.organizationId, requestKey, hash, amount, encrypt(terms.purpose), terms.clientReference ? encrypt(terms.clientReference) : null, terms.fundingId, terms.paymentId, payment ? paymentTermsHash(payment) : null, access.userId, createdAt, createdAt);
    audit(access, id, "created", requestKey, hash, { ...terms, balanceUnchanged: treasury.balance, classification: "client_cash_earmark" });
    return getClientReserve(access, id);
  });
}

export function allocateClientReserve(access: AccessContext, reserveId: string, input: { idempotencyKey: string; paymentId?: string }) {
  manage(access); const requestKey = key(input.idempotencyKey);
  return transaction(() => {
    const reserve = record(access, reserveId), paymentId = input.paymentId ?? reserve.payment_id;
    const hash = fingerprint({ paymentId });
    if (event(access, requestKey, reserveId, "allocated", hash)) return getClientReserve(access, reserveId);
    if (reserve.state === "released") throw new ApiError(409, "A released earmark cannot fund another allocation", "CLIENT_RESERVE_RELEASED");
    if (!paymentId || reserve.payment_id && reserve.payment_id !== paymentId) throw new ApiError(409, "This earmark must remain bound to one exact principal obligation", "CLIENT_PAYMENT_MISMATCH");
    const payment = getPayment(access, paymentId);
    if (!payment.approved_at || !["approved_unfunded", "approved"].includes(payment.status)) throw new ApiError(409, "Approve the underlying obligation before allocating client cash", "CLIENT_PAYMENT_APPROVAL_REQUIRED");
    if (payment.amount !== reserve.amount || reserve.payment_terms_hash && reserve.payment_terms_hash !== paymentTermsHash(payment)) throw new ApiError(409, "The linked payment terms changed. Review the client earmark before using it", "CLIENT_PAYMENT_MISMATCH");
    if (row("SELECT id FROM client_reserves WHERE payment_id=? AND state!='released' AND id!=?", paymentId, reserveId)) throw new ApiError(409, "This principal already belongs to another active client earmark", "CLIENT_PAYMENT_ALREADY_LINKED");
    getDb().prepare("UPDATE client_reserves SET state='allocating',payment_id=?,payment_terms_hash=?,updated_at=? WHERE id=?").run(paymentId, paymentTermsHash(payment), now(), reserveId);
    const funded = approvePayment(access, paymentId);
    const required = atomic(funded.amount) + atomic(funded.max_fee, true) - atomic(funded.total_spent, true);
    if (funded.status !== "approved" || required < atomic(funded.amount) || atomic(funded.reserved_amount, true) < required) throw new ApiError(409, "Operating cash must cover the remaining payment costs. The client earmark is still held", "CLIENT_PAYMENT_COSTS_UNFUNDED");
    getDb().prepare("UPDATE client_reserves SET state='allocated',allocated_at=COALESCE(allocated_at,?),updated_at=? WHERE id=?").run(now(), now(), reserveId);
    audit(access, reserveId, "allocated", requestKey, hash, { paymentId, principal: reserve.amount, paymentReservation: funded.reserved_amount, balanceUnchanged: getTreasury(access).balance, classification: "earmark_to_existing_obligation" });
    return getClientReserve(access, reserveId);
  });
}

export function releaseClientReserve(access: AccessContext, reserveId: string, input: { idempotencyKey: string; reason: string }) {
  manage(access); const requestKey = key(input.idempotencyKey), reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 2000) throw new ApiError(422, "Record a release reason from 3 to 2,000 characters", "CLIENT_RELEASE_REASON_REQUIRED");
  const hash = fingerprint({ reason });
  return transaction(() => {
    const reserve = record(access, reserveId);
    if (event(access, requestKey, reserveId, "released", hash)) return getClientReserve(access, reserveId);
    if (reserve.state === "released") throw new ApiError(409, "This earmark was already released with its recorded reason", "CLIENT_RESERVE_RELEASED");
    getDb().prepare("UPDATE client_reserves SET state='released',release_reason_ciphertext=?,released_at=?,updated_at=? WHERE id=?").run(encrypt(reason), now(), now(), reserveId);
    audit(access, reserveId, "released", requestKey, hash, { reason, balanceUnchanged: getTreasury(access).balance, classification: "bookkeeping_release" });
    return getClientReserve(access, reserveId);
  });
}
