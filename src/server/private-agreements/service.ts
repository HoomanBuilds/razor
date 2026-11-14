import { reserveOptionalCreation } from "../billing/capabilities";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  canonical,
  checkedOffer,
  createTenderSchema,
  digestInput,
  envelopeSchema,
  identifier,
  mandateTermsSchema,
  openedSchema,
  publicKeySchema,
  tenderTermsSchema,
  type MandateTerms,
  type SealedBinding,
  type SealedEnvelope,
  type TenderTerms,
} from "../../lib/private-agreements/schema";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { getRecipient } from "../identity/recipients";
import { audit, getAccess } from "../identity/session";
import { createCommitment } from "../vendor-commitments/service";

interface Tender {
  id: string;
  organization_id: string;
  reference: string;
  current_version: number;
  generation: number;
  state: string;
  commitment_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
interface Version {
  tender_id: string;
  version: number;
  terms_ciphertext: string;
  terms_hash: string;
  buyer_public_key: string;
  published_at: string | null;
  revealed_at: string | null;
  created_by: string;
  created_at: string;
}
interface Invite {
  id: string;
  tender_id: string;
  tender_version: number;
  recipient_id: string;
  supplier_user_id: string;
  supplier_version: number;
  supplier_snapshot_ciphertext: string;
  reply_public_key: string | null;
  created_at: string;
}
interface Sealed {
  id: string;
  invite_id: string;
  revision: number;
  commitment: string;
  binding_json: string;
  envelope_json: string | null;
  status: string;
  purge_at: string;
  deleted_at: string | null;
  created_at: string;
}
interface Mandate {
  id: string;
  invite_id: string;
  terms_ciphertext: string;
  terms_hash: string;
  state: string;
  proposed_by: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}
interface Round {
  id: string;
  mandate_id: string;
  sequence: number;
  actor_user_id: string;
  actor_role: "company" | "supplier";
  commitment: string;
  binding_json: string;
  envelope_json: string | null;
  purge_at: string;
  deleted_at: string | null;
  created_at: string;
}
interface Agreement {
  id: string;
  tender_id: string;
  tender_version: number;
  version: number;
  invite_id: string;
  source_kind: "offer" | "negotiation";
  source_id: string;
  terms_ciphertext: string;
  terms_hash: string;
  total: string;
  state: string;
  company_accepted_by: string | null;
  company_accepted_at: string | null;
  supplier_accepted_by: string | null;
  supplier_accepted_at: string | null;
  commitment_id: string | null;
  proposed_by: string;
  created_at: string;
}
const stamp = () => new Date().toISOString(),
  hash = (input: unknown) =>
    createHash("sha256").update(canonical(input)).digest("hex");
const decisionInput = z
  .object({
    generation: z.number().int().positive(),
    reason: z.string().trim().min(3).max(2000),
  })
  .strict();
const revisionInput = createTenderSchema
  .extend({ generation: z.number().int().positive() })
  .strict();
const privacy =
  "Offer and negotiation content is encrypted to company-owned and supplier-owned keys. Razor sees metadata and selected final terms explicitly disclosed later. Hosted browser JavaScript can access locally opened keys and plaintext. This is not a hardware-proven private auction or cryptographic time lock. Chain payment metadata becomes visible under normal NEAR payment rules; no payment is made here.";

function company(access: AccessContext, permission = "payments:read") {
  const live = getAccess(access.userId, access.organizationId);
  requirePermission(live, "company:read");
  requirePermission(live, permission);
  return live;
}
function tender(id: string, org?: string) {
  const value = row<Tender>(
    `SELECT * FROM private_tenders WHERE id=?${org ? " AND organization_id=?" : ""}`,
    id,
    ...(org ? [org] : []),
  );
  if (!value)
    throw new ApiError(
      404,
      "Private tender not found",
      "PRIVATE_TENDER_NOT_FOUND",
    );
  return value;
}
function version(t: Tender, number = t.current_version) {
  const value = row<Version>(
    "SELECT * FROM private_tender_versions WHERE tender_id=? AND version=?",
    t.id,
    number,
  );
  if (!value)
    throw new ApiError(
      404,
      "Tender version not found",
      "PRIVATE_TENDER_NOT_FOUND",
    );
  return value;
}
function terms(v: Version) {
  return tenderTermsSchema.parse(JSON.parse(decrypt(v.terms_ciphertext)));
}
function invitation(id: string) {
  const value = row<Invite>(
    "SELECT * FROM private_tender_invites WHERE id=?",
    id,
  );
  if (!value)
    throw new ApiError(
      404,
      "Supplier invitation not found",
      "PRIVATE_INVITE_NOT_FOUND",
    );
  return value;
}
function supplier(invite: Invite, userId?: string) {
  if (userId && invite.supplier_user_id !== userId)
    throw new ApiError(
      404,
      "Supplier invitation not found",
      "PRIVATE_INVITE_NOT_FOUND",
    );
  const t = tender(invite.tender_id),
    current = getRecipient(t.organization_id, invite.recipient_id);
  if (
    invite.tender_version !== t.current_version ||
    current.user_id !== invite.supplier_user_id ||
    current.version !== invite.supplier_version ||
    current.archived ||
    current.kind !== "business" ||
    current.preference_status !== "confirmed" ||
    !current.confirmed_at
  )
    throw new ApiError(
      409,
      "The frozen supplier identity or confirmed profile changed. Preserve history and request a new tender version",
      "PRIVATE_SUPPLIER_CHANGED",
    );
  return current;
}
function role(org: string, id: string) {
  const value = row<{ permissions_json: string }>(
    "SELECT permissions_json FROM organization_roles WHERE organization_id=? AND id=? AND archived_at IS NULL",
    org,
    id,
  );
  if (
    !value ||
    !["payments:prepare", "payments:approve"].every((permission) =>
      JSON.parse(value.permissions_json).includes(permission),
    )
  )
    throw new ApiError(
      409,
      "Choose an active company reviewing role with purchasing preparation and approval",
      "PRIVATE_ROLE_REQUIRED",
    );
}
function reviewer(access: AccessContext, t: Tender) {
  const live = company(access, "payments:approve"),
    input = terms(version(t));
  role(t.organization_id, input.reviewingRoleId);
  if (
    !row(
      "SELECT user_id FROM memberships WHERE organization_id=? AND user_id=? AND role_id=? AND status='active'",
      t.organization_id,
      live.userId,
      input.reviewingRoleId,
    )
  )
    throw new ApiError(
      403,
      "The selected tender reviewing role must approve this action",
      "PRIVATE_REVIEW_ROLE_REQUIRED",
    );
  return live;
}
function event(
  t: Tender,
  actor: string,
  actorRole: "company" | "supplier",
  kind: string,
  reason: string,
  inviteId: string | null = null,
) {
  getDb()
    .prepare(
      "INSERT INTO private_agreement_events(id,tender_id,tender_version,invite_id,actor_user_id,actor_role,kind,reason_ciphertext,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(
      randomUUID(),
      t.id,
      t.current_version,
      inviteId,
      actor,
      actorRole,
      kind,
      encrypt(reason),
      stamp(),
    );
  audit(actor, t.organization_id, `private_agreement.${kind}`, t.id, {
    version: t.current_version,
  });
}
function advance(t: Tender, state = t.state) {
  const result = getDb()
    .prepare(
      "UPDATE private_tenders SET generation=generation+1,state=?,updated_at=? WHERE id=? AND generation=?",
    )
    .run(state, stamp(), t.id, t.generation);
  if (Number(result.changes) !== 1)
    throw new ApiError(
      409,
      "The tender changed. Refresh before acting",
      "PRIVATE_REVIEW_CHANGED",
    );
}
function exact(t: Tender, generation: number) {
  if (t.generation !== generation)
    throw new ApiError(
      409,
      "Review the latest tender generation before acting",
      "PRIVATE_REVIEW_CHANGED",
    );
}
function mutable(t: Tender) {
  if (t.commitment_id || ["awarded", "disputed", "closed"].includes(t.state))
    throw new ApiError(
      409,
      "This tender is closed or linked to an immutable agreement. Use its existing PO controls",
      "PRIVATE_TENDER_CLOSED",
    );
}
function activeAgreement(id: string) {
  return row<Agreement>(
    "SELECT * FROM private_agreement_versions WHERE tender_id=? AND state!='cancelled' ORDER BY version DESC LIMIT 1",
    id,
  );
}
function assertNoAgreement(t: Tender) {
  if (activeAgreement(t.id))
    throw new ApiError(
      409,
      "Resolve the existing agreement before changing sourcing or negotiation",
      "PRIVATE_AGREEMENT_EXISTS",
    );
}
function validateTender(input: z.infer<typeof createTenderSchema>) {
  const t = input.terms;
  if (
    BigInt(t.minimumQuantity) > BigInt(t.quantity) ||
    t.deliveryFrom > t.deliveryTo ||
    t.bidDeadline <= stamp() ||
    t.revealAt < t.bidDeadline ||
    t.negotiationDeadline <= t.revealAt ||
    t.negotiationDeadline.slice(0, 10) > t.deliveryTo ||
    Date.parse(t.negotiationDeadline) - Date.now() > 90 * 86400000
  )
    throw new ApiError(
      422,
      "Choose ordered future bid, reveal, negotiation and delivery limits within 90 days",
      "PRIVATE_TENDER_DATES_INVALID",
    );
  if (new Set(input.supplierIds).size !== input.supplierIds.length)
    throw new ApiError(
      422,
      "Invite each business supplier once",
      "PRIVATE_SUPPLIER_DUPLICATE",
    );
}
function saveVersion(
  t: Tender,
  input: z.infer<typeof createTenderSchema>,
  userId: string,
) {
  validateTender(input);
  role(t.organization_id, input.terms.reviewingRoleId);
  const invited = input.supplierIds.map((id) => {
    const value = getRecipient(t.organization_id, id);
    if (
      value.archived ||
      value.kind !== "business" ||
      value.preference_status !== "confirmed" ||
      !value.confirmed_at ||
      !value.user_id
    )
      throw new ApiError(
        409,
        "Invite only current confirmed business supplier accounts",
        "PRIVATE_SUPPLIER_REQUIRED",
      );
    return value;
  });
  const publicKey = publicKeySchema.parse(input.buyerPublicKey),
    fingerprint = hash({
      organizationId: t.organization_id,
      tenderId: t.id,
      version: t.current_version,
      terms: input.terms,
      buyerPublicKey: publicKey,
    });
  getDb()
    .prepare(
      "INSERT INTO private_tender_versions(tender_id,version,terms_ciphertext,terms_hash,buyer_public_key,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      t.id,
      t.current_version,
      encrypt(canonical(input.terms)),
      fingerprint,
      canonical(publicKey),
      userId,
      stamp(),
    );
  for (const value of invited)
    getDb()
      .prepare(
        "INSERT INTO private_tender_invites(id,tender_id,tender_version,recipient_id,supplier_user_id,supplier_version,supplier_snapshot_ciphertext,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        t.id,
        t.current_version,
        value.id,
        value.user_id!,
        value.version,
        encrypt(
          canonical({
            name: value.name,
            asset: value.primary_asset,
            network: value.primary_network,
          }),
        ),
        stamp(),
      );
}
export function purgeEncryptedHistory() {
  const db = getDb(),
    at = stamp();
  for (const table of ["private_sealed_offers", "private_negotiation_rounds"])
    db.prepare(
      `UPDATE ${table} SET envelope_json=NULL,deleted_at=? WHERE envelope_json IS NOT NULL AND purge_at<=?`,
    ).run(at, at);
}
function sealedView<T extends Sealed | Round>(value: T) {
  const { envelope_json, binding_json, ...rest } = value;
  return {
    ...rest,
    binding: JSON.parse(binding_json) as SealedBinding,
    contentAvailable: !!envelope_json,
    disclosure:
      "Encrypted content is fetched individually after authorization; commitment is not a hardware or invoice-truth proof",
  };
}
function mandateView(value: Mandate) {
  const { terms_ciphertext, ...rest } = value;
  return {
    ...rest,
    terms: mandateTermsSchema.parse(JSON.parse(decrypt(terms_ciphertext))),
  };
}
function agreementView(value: Agreement) {
  const { terms_ciphertext, ...rest } = value;
  return {
    ...rest,
    terms: openedSchema.shape.terms.parse(
      JSON.parse(decrypt(terms_ciphertext)),
    ),
    disclosure:
      "These reviewed final terms were explicitly disclosed to Razor and both agreement parties",
  };
}
function detail(t: Tender, userId?: string, requestedVersion?: number) {
  purgeEncryptedHistory();
  const selectedVersion =
    requestedVersion ??
    (userId
      ? row<{ version: number }>(
          "SELECT MAX(i.tender_version) version FROM private_tender_invites i JOIN private_tender_versions v ON v.tender_id=i.tender_id AND v.version=i.tender_version WHERE i.tender_id=? AND i.supplier_user_id=? AND v.published_at IS NOT NULL",
          t.id,
          userId,
        )?.version
      : t.current_version);
  if (
    !selectedVersion ||
    (userId &&
      !row(
        "SELECT id FROM private_tender_invites WHERE tender_id=? AND tender_version=? AND supplier_user_id=?",
        t.id,
        selectedVersion,
        userId,
      ))
  )
    throw new ApiError(
      404,
      "Tender invitation not found",
      "PRIVATE_INVITE_NOT_FOUND",
    );
  const v = version(t, selectedVersion),
    input = terms(v);
  if (userId && !v.published_at)
    throw new ApiError(
      404,
      "Tender invitation not found",
      "PRIVATE_INVITE_NOT_FOUND",
    );
  const invites = rows<Invite>(
    `SELECT * FROM private_tender_invites WHERE tender_id=? AND tender_version=?${userId ? " AND supplier_user_id=?" : ""} ORDER BY id`,
    t.id,
    selectedVersion,
    ...(userId ? [userId] : []),
  );
  const exposedInvites = invites.map((invite) => {
    const historical = invite.tender_version !== t.current_version;
    let identityCurrent = true;
    try {
      supplier(invite, userId);
    } catch {
      identityCurrent = false;
    }
    const mandates = rows<Mandate>(
      "SELECT * FROM private_negotiation_mandates WHERE invite_id=? ORDER BY created_at,id",
      invite.id,
    ).map((value) => ({
      ...mandateView(value),
      rounds: rows<Round>(
        "SELECT * FROM private_negotiation_rounds WHERE mandate_id=? ORDER BY sequence",
        value.id,
      ).map(sealedView),
    }));
    return {
      id: invite.id,
      recipientId: invite.recipient_id,
      supplierUserId: invite.supplier_user_id,
      supplierVersion: invite.supplier_version,
      tenderVersion: invite.tender_version,
      historical,
      identityCurrent,
      supplier: JSON.parse(decrypt(invite.supplier_snapshot_ciphertext)) as {
        name: string;
        asset: string;
        network: string;
      },
      replyPublicKey: invite.reply_public_key
        ? publicKeySchema.parse(JSON.parse(invite.reply_public_key))
        : null,
      offers: rows<Sealed>(
        "SELECT * FROM private_sealed_offers WHERE invite_id=? ORDER BY revision DESC",
        invite.id,
      ).map(sealedView),
      mandates,
    };
  });
  const agreementRows = rows<Agreement>(
    `SELECT a.* FROM private_agreement_versions a JOIN private_tender_invites i ON i.id=a.invite_id WHERE a.tender_id=? AND a.tender_version=?${userId ? " AND i.supplier_user_id=?" : ""} ORDER BY a.version DESC`,
    t.id,
    selectedVersion,
    ...(userId ? [userId] : []),
  );
  return {
    ...t,
    selectedVersion,
    historical: selectedVersion !== t.current_version,
    revealAuthorized: !!v.revealed_at && input.revealAt <= stamp(),
    terms: input,
    termsHash: v.terms_hash,
    buyerPublicKey: publicKeySchema.parse(JSON.parse(v.buyer_public_key)),
    companyName: row<{ name: string }>(
      "SELECT name FROM organizations WHERE id=?",
      t.organization_id,
    )!.name,
    invites: exposedInvites,
    agreements: agreementRows.map(agreementView),
    versions: rows<{ version: number; terms_hash: string; created_at: string }>(
      `SELECT v.version,v.terms_hash,v.created_at FROM private_tender_versions v WHERE v.tender_id=?${userId ? " AND v.published_at IS NOT NULL AND EXISTS(SELECT 1 FROM private_tender_invites i WHERE i.tender_id=v.tender_id AND i.tender_version=v.version AND i.supplier_user_id=?)" : ""} ORDER BY v.version DESC`,
      t.id,
      ...(userId ? [userId] : []),
    ),
    history: rows<{
      id: string;
      kind: string;
      actor_role: string;
      tender_version: number;
      reason_ciphertext: string;
      created_at: string;
    }>(
      `SELECT id,kind,actor_role,tender_version,reason_ciphertext,created_at FROM private_agreement_events WHERE tender_id=? AND tender_version=?${userId ? " AND (invite_id IN (SELECT id FROM private_tender_invites WHERE tender_id=? AND supplier_user_id=?) OR invite_id IS NULL)" : ""} ORDER BY sequence DESC LIMIT 200`,
      t.id,
      selectedVersion,
      ...(userId ? [t.id, userId] : []),
    ).map(({ reason_ciphertext, ...value }) => ({
      ...value,
      reason: decrypt(reason_ciphertext),
    })),
    privacy,
    now: stamp(),
  };
}
export function companyOverview(access: AccessContext) {
  const live = company(access);
  return {
    tenders: rows<Tender>(
      "SELECT * FROM private_tenders WHERE organization_id=? ORDER BY created_at DESC,id LIMIT 100",
      live.organizationId,
    ),
    suppliers: rows<{ id: string }>(
      "SELECT id FROM recipients WHERE organization_id=? AND archived=0 AND kind='business' AND preference_status='confirmed' AND user_id IS NOT NULL ORDER BY created_at DESC LIMIT 100",
      live.organizationId,
    ).map((value) => {
      const profile = getRecipient(live.organizationId, value.id);
      return {
        id: profile.id,
        name: profile.name,
        version: profile.version,
        asset: profile.primary_asset,
        network: profile.primary_network,
      };
    }),
    roles: rows<{ id: string; name: string; permissions_json: string }>(
      "SELECT id,name,permissions_json FROM organization_roles WHERE organization_id=? AND archived_at IS NULL ORDER BY name",
      live.organizationId,
    )
      .filter((value) =>
        ["payments:prepare", "payments:approve"].every((permission) =>
          JSON.parse(value.permissions_json).includes(permission),
        ),
      )
      .map(({ id, name }) => ({ id, name })),
    privacy,
  };
}
export function companyDetail(
  access: AccessContext,
  id: string,
  number?: number,
) {
  const live = company(access);
  return detail(tender(id, live.organizationId), undefined, number);
}
export function supplierDetail(userId: string, id: string, number?: number) {
  return detail(tender(id), userId, number);
}
export function supplierOverview(userId: string) {
  return {
    tenders: rows<Pick<Tender, "id" | "reference" | "state" | "created_at">>(
      "SELECT DISTINCT t.id,t.reference,t.state,t.created_at FROM private_tenders t JOIN private_tender_invites i ON i.tender_id=t.id JOIN private_tender_versions v ON v.tender_id=i.tender_id AND v.version=i.tender_version WHERE i.supplier_user_id=? AND v.published_at IS NOT NULL ORDER BY t.created_at DESC,t.id LIMIT 100",
      userId,
    ),
    privacy,
  };
}
export function createTender(access: AccessContext, data: unknown) {
  const live = company(access, "payments:prepare"),
    input = createTenderSchema.parse(data);
  return transaction((db) => {
    const id = randomUUID(),
      at = stamp();
    if (
      row(
        "SELECT id FROM private_tenders WHERE organization_id=? AND reference=?",
        live.organizationId,
        input.terms.reference,
      )
    )
      throw new ApiError(
        409,
        "This tender reference already exists",
        "PRIVATE_REFERENCE_EXISTS",
      );
    reserveOptionalCreation(live, "private_tender", id);
    db.prepare(
      "INSERT INTO private_tenders(id,organization_id,reference,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    ).run(id, live.organizationId, input.terms.reference, live.userId, at, at);
    const t = tender(id);
    saveVersion(t, input, live.userId);
    event(
      t,
      live.userId,
      "company",
      "created",
      "Company-owned public encryption key and supplier invitation identities captured",
    );
    return detail(t);
  });
}
export function reviseTender(access: AccessContext, id: string, data: unknown) {
  const live = company(access, "payments:prepare"),
    input = revisionInput.parse(data);
  return transaction((db) => {
    const t = tender(id, live.organizationId);
    exact(t, input.generation);
    if (
      t.commitment_id ||
      activeAgreement(id) ||
      !["draft", "closed"].includes(t.state)
    )
      throw new ApiError(
        409,
        "Close an unawarded tender before reopening a new version. Existing obligations cannot be reopened",
        "PRIVATE_REOPEN_HELD",
      );
    if (t.current_version >= 20 || input.terms.reference !== t.reference)
      throw new ApiError(
        422,
        "Keep the reference and no more than twenty tender versions",
        "PRIVATE_VERSION_LIMIT",
      );
    advance(t, "draft");
    db.prepare(
      "UPDATE private_tenders SET current_version=current_version+1 WHERE id=?",
    ).run(id);
    const next = tender(id);
    saveVersion(next, input, live.userId);
    event(
      next,
      live.userId,
      "company",
      "reopened",
      "Fresh dates, public key and supplier identities require new tender review",
    );
    return detail(next);
  });
}
export function tenderAction(
  access: AccessContext,
  id: string,
  action: "publish" | "reveal" | "close",
  data: unknown,
) {
  const input = decisionInput.parse(data);
  return transaction(() => {
    const t = tender(id, access.organizationId),
      live = reviewer(access, t);
    exact(t, input.generation);
    const rules = terms(version(t));
    if (action === "publish") {
      if (t.state !== "draft" || rules.bidDeadline <= stamp())
        throw new ApiError(
          409,
          "Review a current draft before publishing invitations",
          "PRIVATE_TENDER_CLOSED",
        );
      for (const invite of rows<Invite>(
        "SELECT * FROM private_tender_invites WHERE tender_id=? AND tender_version=?",
        id,
        t.current_version,
      ))
        supplier(invite);
      getDb()
        .prepare(
          "UPDATE private_tender_versions SET published_at=? WHERE tender_id=? AND version=? AND published_at IS NULL",
        )
        .run(stamp(), id, t.current_version);
      advance(t, "open");
    }
    if (action === "reveal") {
      if (t.state !== "open" || stamp() < rules.revealAt)
        throw new ApiError(
          409,
          "The agreed buyer reveal time has not arrived",
          "PRIVATE_REVEAL_HELD",
        );
      getDb()
        .prepare(
          "UPDATE private_tender_versions SET revealed_at=? WHERE tender_id=? AND version=? AND revealed_at IS NULL",
        )
        .run(stamp(), id, t.current_version);
      advance(t, "revealed");
    }
    if (action === "close") {
      if (t.commitment_id || activeAgreement(id))
        throw new ApiError(
          409,
          "Resolve the agreement or use its existing PO controls. Closing cannot erase an obligation",
          "PRIVATE_CLOSE_HELD",
        );
      advance(t, "closed");
    }
    event(t, live.userId, "company", action, input.reason);
    return detail(tender(id));
  });
}
function expectedBinding(
  t: Tender,
  invite: Invite,
  revision: number,
  phase: "offer" | "negotiation",
  author: "company" | "supplier",
  mandateId: string | null,
): SealedBinding {
  return {
    schema: "razor.sealed-agreement",
    organizationId: t.organization_id,
    tenderId: t.id,
    tenderVersion: t.current_version,
    tenderHash: version(t).terms_hash,
    inviteId: invite.id,
    supplierUserId: invite.supplier_user_id,
    supplierVersion: invite.supplier_version,
    revision,
    phase,
    mandateId,
    author,
  };
}
function checkEnvelope(
  t: Tender,
  invite: Invite,
  input: unknown,
  binding: SealedBinding,
) {
  const envelope = envelopeSchema.parse(input);
  if (canonical(envelope.binding) !== canonical(binding))
    throw new ApiError(
      409,
      "The sealed envelope belongs to different parties, terms or version",
      "PRIVATE_SEAL_BINDING_CHANGED",
    );
  const keyIds = [
    hash(publicKeySchema.parse(JSON.parse(version(t).buyer_public_key))),
    ...(invite.reply_public_key
      ? [hash(publicKeySchema.parse(JSON.parse(invite.reply_public_key)))]
      : []),
  ];
  if (
    new Set(keyIds).size !== keyIds.length ||
    canonical(envelope.wrappedKeys.map((value) => value.keyId).sort()) !==
      canonical(keyIds.sort())
  )
    throw new ApiError(
      422,
      "Encrypt to exactly the captured company and supplier keys",
      "PRIVATE_SEAL_KEY_REQUIRED",
    );
  return envelope;
}
export function submitOffer(userId: string, inviteId: string, data: unknown) {
  const input = z
    .object({
      expectedRevision: z.number().int().min(0).max(19),
      replyPublicKey: publicKeySchema,
      envelope: envelopeSchema,
    })
    .strict()
    .parse(data);
  return transaction((db) => {
    const invite = invitation(inviteId),
      t = tender(invite.tender_id);
    supplier(invite, userId);
    mutable(t);
    assertNoAgreement(t);
    const rules = terms(version(t));
    if (t.state !== "open" || stamp() >= rules.bidDeadline)
      throw new ApiError(
        409,
        "The sealed submission window has closed",
        "PRIVATE_BIDS_CLOSED",
      );
    const revision =
      row<{ revision: number }>(
        "SELECT MAX(revision) revision FROM private_sealed_offers WHERE invite_id=?",
        inviteId,
      )?.revision ?? 0;
    if (revision !== input.expectedRevision)
      throw new ApiError(
        409,
        "A different offer revision exists. Refresh first",
        "PRIVATE_OFFER_CHANGED",
      );
    if (
      invite.reply_public_key &&
      canonical(input.replyPublicKey) !== invite.reply_public_key
    )
      throw new ApiError(
        409,
        "Keep this invitation's reply key. New encryption identities require a new tender version",
        "PRIVATE_REPLY_KEY_CHANGED",
      );
    db.prepare(
      "UPDATE private_tender_invites SET reply_public_key=? WHERE id=? AND reply_public_key IS NULL",
    ).run(canonical(input.replyPublicKey), inviteId);
    invite.reply_public_key = canonical(input.replyPublicKey);
    const envelope = checkEnvelope(
      t,
      invite,
      input.envelope,
      expectedBinding(t, invite, revision + 1, "offer", "supplier", null),
    );
    db.prepare(
      "INSERT INTO private_sealed_offers(id,invite_id,revision,commitment,binding_json,envelope_json,purge_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      inviteId,
      revision + 1,
      envelope.commitment,
      canonical(envelope.binding),
      canonical(envelope),
      new Date(
        Date.parse(rules.negotiationDeadline) +
          rules.encryptedRetentionDays * 86400000,
      ).toISOString(),
      stamp(),
    );
    advance(t);
    event(
      t,
      userId,
      "supplier",
      "offer_sealed",
      "An immutable encrypted offer revision was submitted; commercial terms remain hidden from Razor",
      inviteId,
    );
    return detail(tender(t.id), userId);
  });
}
export function withdrawOffer(userId: string, id: string, data: unknown) {
  const input = z
    .object({
      expectedRevision: z.number().int().positive(),
      reason: z.string().trim().min(3).max(2000),
    })
    .strict()
    .parse(data);
  return transaction((db) => {
    const invite = invitation(id),
      t = tender(invite.tender_id);
    supplier(invite, userId);
    mutable(t);
    assertNoAgreement(t);
    const offer = row<Sealed>(
      "SELECT * FROM private_sealed_offers WHERE invite_id=? ORDER BY revision DESC LIMIT 1",
      id,
    );
    if (
      !offer ||
      offer.revision !== input.expectedRevision ||
      offer.status !== "submitted"
    )
      throw new ApiError(
        409,
        "Only the current submitted offer can be withdrawn",
        "PRIVATE_OFFER_CHANGED",
      );
    db.prepare(
      "UPDATE private_sealed_offers SET status='withdrawn' WHERE id=?",
    ).run(offer.id);
    advance(t);
    event(t, userId, "supplier", "offer_withdrawn", input.reason, id);
    return detail(tender(t.id), userId);
  });
}

function mandate(id: string) {
  const value = row<Mandate>(
    "SELECT * FROM private_negotiation_mandates WHERE id=?",
    id,
  );
  if (!value)
    throw new ApiError(
      404,
      "Negotiation mandate not found",
      "PRIVATE_MANDATE_NOT_FOUND",
    );
  return value;
}
function mandateAuthorization(t: Tender, value: Mandate) {
  if (!value.approved_by || value.approved_by === value.proposed_by)
    throw new ApiError(
      409,
      "The mandate requires independent company authorization",
      "PRIVATE_MANDATE_HELD",
    );
  requirePermission(
    getAccess(value.proposed_by, t.organization_id),
    "payments:prepare",
  );
  reviewer(getAccess(value.approved_by, t.organization_id), t);
}
function mandateReady(t: Tender, invite: Invite, value: Mandate) {
  const input = mandateView(value).terms,
    rules = terms(version(t));
  supplier(invite);
  mutable(t);
  assertNoAgreement(t);
  const offer = row<Sealed>(
    "SELECT * FROM private_sealed_offers WHERE invite_id=? ORDER BY revision DESC LIMIT 1",
    invite.id,
  );
  if (
    t.state !== "revealed" ||
    value.state !== "approved" ||
    !value.approved_by ||
    !offer ||
    offer.status !== "submitted" ||
    input.expiresAt <= stamp() ||
    rules.negotiationDeadline <= stamp()
  )
    throw new ApiError(
      409,
      "Negotiation requires an active, independently authorized mandate and a current submitted offer",
      "PRIVATE_NEGOTIATION_HELD",
    );
  mandateAuthorization(t, value);
  return input;
}
export function proposeMandate(
  access: AccessContext,
  id: string,
  data: unknown,
) {
  const live = company(access, "payments:prepare"),
    input = z
      .object({
        generation: z.number().int().positive(),
        inviteId: identifier,
        terms: mandateTermsSchema,
      })
      .strict()
      .parse(data);
  return transaction((db) => {
    const t = tender(id, live.organizationId),
      invite = invitation(input.inviteId),
      rules = terms(version(t));
    exact(t, input.generation);
    mutable(t);
    assertNoAgreement(t);
    supplier(invite);
    if (
      invite.tender_id !== id ||
      t.state !== "revealed" ||
      input.terms.expiresAt <= stamp() ||
      input.terms.expiresAt > rules.negotiationDeadline ||
      BigInt(input.terms.maximumTotal) > BigInt(rules.budget) ||
      BigInt(input.terms.minimumQuantity) < BigInt(rules.minimumQuantity) ||
      BigInt(input.terms.minimumQuantity) >
        BigInt(input.terms.maximumQuantity) ||
      BigInt(input.terms.maximumQuantity) > BigInt(rules.quantity) ||
      input.terms.deliveryFrom < rules.deliveryFrom ||
      input.terms.deliveryTo > rules.deliveryTo ||
      input.terms.deliveryFrom > input.terms.deliveryTo
    )
      throw new ApiError(
        422,
        "The mandate must stay inside this revealed tender's fixed counterparty, budget, quantity, delivery and time limits",
        "PRIVATE_MANDATE_LIMITS",
      );
    if (
      row<{ count: number }>(
        "SELECT COUNT(*) count FROM private_negotiation_mandates WHERE invite_id=?",
        invite.id,
      )!.count >= 8
    )
      throw new ApiError(
        409,
        "This invitation reached eight immutable mandates",
        "PRIVATE_MANDATE_LIMIT",
      );
    if (
      row<{ status: string }>(
        "SELECT status FROM private_sealed_offers WHERE invite_id=? ORDER BY revision DESC LIMIT 1",
        invite.id,
      )?.status !== "submitted"
    )
      throw new ApiError(
        409,
        "A current submitted supplier offer is required before negotiation",
        "PRIVATE_NEGOTIATION_HELD",
      );
    const mandateId = randomUUID(),
      fingerprint = hash({
        tenderHash: version(t).terms_hash,
        inviteId: invite.id,
        terms: input.terms,
      });
    db.prepare(
      "INSERT INTO private_negotiation_mandates(id,invite_id,terms_ciphertext,terms_hash,proposed_by,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      mandateId,
      invite.id,
      encrypt(canonical(input.terms)),
      fingerprint,
      live.userId,
      stamp(),
    );
    advance(t);
    event(
      t,
      live.userId,
      "company",
      "mandate_proposed",
      "Separate company authorization is required before any bounded negotiation round",
      invite.id,
    );
    return detail(tender(id));
  });
}
export function decideMandate(
  access: AccessContext,
  id: string,
  data: unknown,
) {
  const input = z
    .object({
      generation: z.number().int().positive(),
      termsHash: digestInput,
      action: z.enum(["approve", "revoke"]),
      reason: z.string().trim().min(3).max(2000),
    })
    .strict()
    .parse(data);
  return transaction((db) => {
    const value = mandate(id),
      invite = invitation(value.invite_id),
      t = tender(invite.tender_id),
      live = reviewer(access, tender(t.id, access.organizationId));
    exact(t, input.generation);
    mutable(t);
    assertNoAgreement(t);
    supplier(invite);
    if (value.terms_hash !== input.termsHash || value.state === "revoked")
      throw new ApiError(
        409,
        "Review the current immutable mandate",
        "PRIVATE_MANDATE_CHANGED",
      );
    if (input.action === "approve") {
      if (
        value.state !== "proposed" ||
        value.proposed_by === live.userId ||
        mandateView(value).terms.expiresAt <= stamp()
      )
        throw new ApiError(
          409,
          "A different authorized company reviewer must approve a fresh unexpired mandate",
          "PRIVATE_INDEPENDENT_REVIEW_REQUIRED",
        );
      db.prepare(
        "UPDATE private_negotiation_mandates SET state='approved',approved_by=?,approved_at=? WHERE id=? AND state='proposed'",
      ).run(live.userId, stamp(), id);
    } else
      db.prepare(
        "UPDATE private_negotiation_mandates SET state='revoked' WHERE id=?",
      ).run(id);
    advance(t);
    event(
      t,
      live.userId,
      "company",
      input.action === "approve" ? "mandate_approved" : "mandate_revoked",
      input.reason,
      invite.id,
    );
    return detail(tender(t.id));
  });
}
export function submitNegotiation(
  actor: AccessContext | string,
  id: string,
  data: unknown,
) {
  const input = z
    .object({
      expectedSequence: z.number().int().min(0).max(15),
      envelope: envelopeSchema,
    })
    .strict()
    .parse(data);
  return transaction((db) => {
    const value = mandate(id),
      invite = invitation(value.invite_id),
      t = tender(invite.tender_id),
      rules = mandateReady(t, invite, value),
      actorRole = typeof actor === "string" ? "supplier" : "company";
    const actorId =
      typeof actor === "string"
        ? actor
        : company(actor, "payments:prepare").userId;
    if (typeof actor === "string") supplier(invite, actor);
    else if (actor.organizationId !== t.organization_id)
      throw new ApiError(
        404,
        "Negotiation mandate not found",
        "PRIVATE_MANDATE_NOT_FOUND",
      );
    const sequence =
      row<{ sequence: number }>(
        "SELECT MAX(sequence) sequence FROM private_negotiation_rounds WHERE mandate_id=?",
        id,
      )?.sequence ?? 0;
    if (
      sequence !== input.expectedSequence ||
      sequence >= rules.maximumRounds * 2 ||
      actorRole !== (sequence % 2 === 0 ? "company" : "supplier")
    )
      throw new ApiError(
        409,
        "Refresh the transcript and wait for your turn within the authorized round limit",
        "PRIVATE_NEGOTIATION_ROUND_HELD",
      );
    const envelope = checkEnvelope(
      t,
      invite,
      input.envelope,
      expectedBinding(t, invite, sequence + 1, "negotiation", actorRole, id),
    );
    db.prepare(
      "INSERT INTO private_negotiation_rounds(id,mandate_id,sequence,actor_user_id,actor_role,commitment,binding_json,envelope_json,purge_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      id,
      sequence + 1,
      actorId,
      actorRole,
      envelope.commitment,
      canonical(envelope.binding),
      canonical(envelope),
      new Date(
        Date.parse(terms(version(t)).negotiationDeadline) +
          terms(version(t)).encryptedRetentionDays * 86400000,
      ).toISOString(),
      stamp(),
    );
    advance(t);
    event(
      t,
      actorId,
      actorRole,
      "negotiation_sealed",
      "Encrypted proposal only. Bounds are checked by the local editor and again on final disclosure; the host cannot inspect sealed price terms",
      invite.id,
    );
    return detail(tender(t.id), typeof actor === "string" ? actor : undefined);
  });
}
function source(id: string, kind: "offer" | "negotiation") {
  if (kind === "offer") {
    const value = row<Sealed>(
      "SELECT * FROM private_sealed_offers WHERE id=?",
      id,
    );
    if (!value)
      throw new ApiError(
        404,
        "Sealed offer not found",
        "PRIVATE_SEAL_NOT_FOUND",
      );
    return { value, invite: invitation(value.invite_id), mandate: null };
  }
  const value = row<Round>(
    "SELECT * FROM private_negotiation_rounds WHERE id=?",
    id,
  );
  if (!value)
    throw new ApiError(404, "Sealed round not found", "PRIVATE_SEAL_NOT_FOUND");
  const m = mandate(value.mandate_id);
  return { value, invite: invitation(m.invite_id), mandate: m };
}
export function downloadSealed(
  actor: AccessContext | string,
  kind: "offer" | "negotiation",
  id: string,
) {
  purgeEncryptedHistory();
  const found = source(id, kind),
    t = tender(found.invite.tender_id);
  if (typeof actor === "string") {
    if (found.invite.supplier_user_id !== actor)
      throw new ApiError(
        404,
        "Sealed record not found",
        "PRIVATE_SEAL_NOT_FOUND",
      );
  } else {
    company(actor);
    if (actor.organizationId !== t.organization_id)
      throw new ApiError(
        404,
        "Sealed record not found",
        "PRIVATE_SEAL_NOT_FOUND",
      );
    const v = version(t, found.invite.tender_version),
      rules = terms(v);
    if (!v.revealed_at || rules.revealAt > stamp())
      throw new ApiError(
        409,
        "Explicit buyer reveal after the agreed time is required before this export",
        "PRIVATE_REVEAL_HELD",
      );
  }
  if (!found.value.envelope_json)
    throw new ApiError(
      410,
      "Encrypted content was deleted or its retention ended. The commitment and decisions remain",
      "PRIVATE_CONTENT_DELETED",
    );
  return {
    envelope: envelopeSchema.parse(JSON.parse(found.value.envelope_json)),
    privacy,
  };
}
export function discloseFinal(
  access: AccessContext,
  id: string,
  data: unknown,
) {
  const input = z
    .object({
      generation: z.number().int().positive(),
      sourceKind: z.enum(["offer", "negotiation"]),
      sourceId: identifier,
      opened: openedSchema,
      discloseToRazor: z.literal(true),
    })
    .strict()
    .parse(data);
  return transaction((db) => {
    const t = tender(id, access.organizationId),
      live = reviewer(access, t);
    exact(t, input.generation);
    mutable(t);
    assertNoAgreement(t);
    const found = source(input.sourceId, input.sourceKind),
      invite = found.invite,
      rules = terms(version(t));
    supplier(invite);
    if (
      invite.tender_id !== t.id ||
      invite.tender_version !== t.current_version ||
      t.state !== "revealed" ||
      rules.negotiationDeadline <= stamp()
    )
      throw new ApiError(
        409,
        "Publish selected terms only from this active revealed tender",
        "PRIVATE_DISCLOSURE_HELD",
      );
    const latestOffer = row<Sealed>(
      "SELECT * FROM private_sealed_offers WHERE invite_id=? ORDER BY revision DESC LIMIT 1",
      invite.id,
    );
    if (
      !latestOffer ||
      latestOffer.status !== "submitted" ||
      (input.sourceKind === "offer" && latestOffer.id !== input.sourceId)
    )
      throw new ApiError(
        409,
        "The supplier withdrew or replaced this sealed offer",
        "PRIVATE_OFFER_CHANGED",
      );
    const m = found.mandate
      ? mandateReady(t, invite, found.mandate)
      : undefined;
    if (
      found.mandate &&
      row<{ id: string }>(
        "SELECT id FROM private_negotiation_rounds WHERE mandate_id=? ORDER BY sequence DESC LIMIT 1",
        found.mandate.id,
      )?.id !== input.sourceId
    )
      throw new ApiError(
        409,
        "Select the latest exact negotiation round",
        "PRIVATE_NEGOTIATION_ROUND_HELD",
      );
    if (
      hash({
        binding: JSON.parse(found.value.binding_json),
        ...input.opened,
      }) !== found.value.commitment
    )
      throw new ApiError(
        422,
        "The disclosed complete terms do not match the immutable sealed commitment",
        "PRIVATE_COMMITMENT_MISMATCH",
      );
    let checked: ReturnType<typeof checkedOffer>;
    try {
      checked = checkedOffer(rules, input.opened.terms, m);
    } catch (error) {
      throw new ApiError(422, (error as Error).message, "PRIVATE_FINAL_LIMITS");
    }
    if (checked.terms.validUntil <= stamp())
      throw new ApiError(
        409,
        "The selected commercial offer expired before agreement",
        "PRIVATE_AGREEMENT_EXPIRED",
      );
    const number =
      (row<{ version: number }>(
        "SELECT MAX(version) version FROM private_agreement_versions WHERE tender_id=?",
        id,
      )?.version ?? 0) + 1;
    if (number > 20)
      throw new ApiError(
        409,
        "This tender reached twenty agreement versions",
        "PRIVATE_VERSION_LIMIT",
      );
    const agreementId = randomUUID(),
      fingerprint = hash({
        schema: "razor.final-agreement",
        version: 1,
        agreementId,
        organizationId: t.organization_id,
        tenderId: t.id,
        tenderVersion: t.current_version,
        tenderHash: version(t).terms_hash,
        supplierUserId: invite.supplier_user_id,
        supplierVersion: invite.supplier_version,
        recipientId: invite.recipient_id,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        sourceCommitment: found.value.commitment,
        terms: checked.terms,
        total: checked.total,
      });
    db.prepare(
      "INSERT INTO private_agreement_versions(id,tender_id,tender_version,version,invite_id,source_kind,source_id,terms_ciphertext,terms_hash,total,proposed_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      agreementId,
      id,
      t.current_version,
      number,
      invite.id,
      input.sourceKind,
      input.sourceId,
      encrypt(canonical(checked.terms)),
      fingerprint,
      checked.total,
      live.userId,
      stamp(),
    );
    advance(t);
    event(
      t,
      live.userId,
      "company",
      "selected_terms_disclosed",
      "Selected complete commercial terms explicitly disclosed to Razor. Both exact parties must accept before a separately approved PO proposal",
      invite.id,
    );
    return detail(tender(id));
  });
}
function agreement(id: string) {
  const value = row<Agreement>(
    "SELECT * FROM private_agreement_versions WHERE id=?",
    id,
  );
  if (!value)
    throw new ApiError(
      404,
      "Agreement not found",
      "PRIVATE_AGREEMENT_NOT_FOUND",
    );
  return value;
}
export function decideAgreement(
  actor: AccessContext | string,
  id: string,
  data: unknown,
) {
  const input = z
    .object({
      generation: z.number().int().positive(),
      termsHash: digestInput,
      action: z.enum(["accept", "cancel", "dispute"]),
      reason: z.string().trim().min(3).max(2000),
    })
    .strict()
    .parse(data);
  return transaction((db) => {
    const value = agreement(id),
      t = tender(value.tender_id),
      invite = invitation(value.invite_id),
      actorRole = typeof actor === "string" ? "supplier" : "company",
      actorId =
        typeof actor === "string"
          ? actor
          : reviewer(actor, tender(t.id, actor.organizationId)).userId;
    if (typeof actor === "string" && invite.supplier_user_id !== actor)
      throw new ApiError(
        404,
        "Agreement not found",
        "PRIVATE_AGREEMENT_NOT_FOUND",
      );
    exact(t, input.generation);
    if (
      input.termsHash !== value.terms_hash ||
      value.state === "cancelled" ||
      value.state === "disputed"
    )
      throw new ApiError(
        409,
        "Review the current exact agreement",
        "PRIVATE_AGREEMENT_CHANGED",
      );
    if (input.action === "accept") {
      supplier(invite, typeof actor === "string" ? actor : undefined);
      if (
        value.state !== "pending" ||
        agreementView(value).terms.validUntil <= stamp() ||
        terms(version(t)).negotiationDeadline <= stamp()
      )
        throw new ApiError(
          409,
          "This final agreement is no longer open for acceptance",
          "PRIVATE_AGREEMENT_EXPIRED",
        );
      if (actorRole === "company")
        db.prepare(
          "UPDATE private_agreement_versions SET company_accepted_by=?,company_accepted_at=? WHERE id=? AND company_accepted_by IS NULL",
        ).run(actorId, stamp(), id);
      else
        db.prepare(
          "UPDATE private_agreement_versions SET supplier_accepted_by=?,supplier_accepted_at=? WHERE id=? AND supplier_accepted_by IS NULL",
        ).run(actorId, stamp(), id);
      db.prepare(
        "UPDATE private_agreement_versions SET state='accepted' WHERE id=? AND company_accepted_by IS NOT NULL AND supplier_accepted_by IS NOT NULL",
      ).run(id);
    } else if (input.action === "cancel") {
      if (value.state !== "pending" || value.commitment_id || t.commitment_id)
        throw new ApiError(
          409,
          "Accepted agreements and PO obligations cannot be erased or reopened here. Use their existing dispute and PO controls",
          "PRIVATE_CANCELLATION_HELD",
        );
      db.prepare(
        "UPDATE private_agreement_versions SET state='cancelled' WHERE id=? AND state='pending'",
      ).run(id);
    } else {
      db.prepare(
        "UPDATE private_agreement_versions SET state='disputed' WHERE id=?",
      ).run(id);
    }
    advance(t, input.action === "dispute" ? "disputed" : t.state);
    event(
      t,
      actorId,
      actorRole,
      input.action === "accept"
        ? "agreement_accepted_by_party"
        : input.action === "cancel"
          ? "agreement_cancelled"
          : "agreement_disputed",
      input.reason,
      invite.id,
    );
    return detail(tender(t.id), typeof actor === "string" ? actor : undefined);
  });
}
export function createAgreementPurchase(
  access: AccessContext,
  id: string,
  data: unknown,
) {
  const input = z
    .object({
      generation: z.number().int().positive(),
      termsHash: digestInput,
      purchaseReference: z.string().trim().min(1).max(120),
      separateApprovalAcknowledged: z.literal(true),
    })
    .strict()
    .parse(data);
  return transaction((db) => {
    const value = agreement(id),
      t = tender(value.tender_id, access.organizationId),
      live = reviewer(access, t);
    requirePermission(live, "payments:prepare");
    if (value.commitment_id) {
      const previous = row<{ reference: string }>(
        "SELECT reference FROM vendor_commitments WHERE id=?",
        value.commitment_id,
      );
      if (
        value.terms_hash !== input.termsHash ||
        previous?.reference !== input.purchaseReference
      )
        throw new ApiError(
          409,
          "This exact agreement already has a different PO reference",
          "PRIVATE_PO_EXISTS",
        );
      return detail(t);
    }
    exact(t, input.generation);
    const invite = invitation(value.invite_id);
    supplier(invite);
    const rules = terms(version(t)),
      final = agreementView(value),
      checked = checkedOffer(rules, final.terms);
    if (
      t.commitment_id ||
      t.state !== "revealed" ||
      value.state !== "accepted" ||
      !value.company_accepted_by ||
      !value.supplier_accepted_by ||
      value.terms_hash !== input.termsHash ||
      final.terms.validUntil <= stamp() ||
      rules.negotiationDeadline <= stamp()
    )
      throw new ApiError(
        409,
        "Both exact parties must accept the current unexpired agreement before one PO proposal",
        "PRIVATE_PO_HELD",
      );
    if (value.source_kind === "negotiation") {
      const found = source(value.source_id, value.source_kind),
        m = mandateView(found.mandate!).terms;
      if (found.mandate!.state !== "approved" || m.expiresAt <= stamp())
        throw new ApiError(
          409,
          "The negotiated agreement's authorization expired or was revoked",
          "PRIVATE_MANDATE_HELD",
        );
      mandateAuthorization(t, found.mandate!);
      checkedOffer(rules, final.terms, m);
    }
    const purchase = createCommitment(live, {
      recipientId: invite.recipient_id,
      reference: input.purchaseReference,
      settlementUnit: "USDC",
      scope: `Private agreement ${t.reference}, immutable version ${value.version}, SHA-256 ${value.terms_hash}. Exact quantity ${final.terms.quantity} ${rules.unit}; all included commercial charges total ${checked.total} microUSDC. Full selected conditions are in Private agreements. Excluded charges and supplier conversion estimates are outside this PO allowance.\n${rules.specification.slice(0, 800)}\n${final.terms.terms.slice(0, 800)}`,
      allowance: checked.total,
      cadence: "total",
      startsOn: stamp().slice(0, 10),
      endsOn: final.terms.deliveryDate,
      targetState: "active",
      reason:
        "Both exact agreement parties accepted; normal independent PO approval and invoice/payment controls remain required",
    });
    db.prepare(
      "UPDATE private_agreement_versions SET commitment_id=?,state='po_proposed' WHERE id=? AND commitment_id IS NULL",
    ).run(purchase.id, id);
    db.prepare(
      "UPDATE private_tenders SET commitment_id=? WHERE id=? AND commitment_id IS NULL",
    ).run(purchase.id, t.id);
    advance(t, "awarded");
    event(
      t,
      live.userId,
      "company",
      "po_proposed",
      "One ordinary unapproved purchase commitment was proposed. No invoice, approval, signature or payment was created",
      invite.id,
    );
    return detail(tender(t.id));
  });
}
export function deleteEncryptedContent(
  actor: AccessContext | string,
  kind: "offer" | "negotiation",
  id: string,
  data: unknown,
) {
  const input = z
    .object({
      commitment: digestInput,
      deleteCiphertextAcknowledged: z.literal(true),
    })
    .strict()
    .parse(data);
  return transaction((db) => {
    const found = source(id, kind),
      t = tender(found.invite.tender_id),
      actorId =
        typeof actor === "string"
          ? actor
          : company(actor, "documents:manage").userId;
    if (
      typeof actor === "string"
        ? found.invite.supplier_user_id !== actor
        : actor.organizationId !== t.organization_id
    )
      throw new ApiError(
        404,
        "Sealed content not found",
        "PRIVATE_SEAL_NOT_FOUND",
      );
    if (input.commitment !== found.value.commitment)
      throw new ApiError(
        409,
        "Review the exact encrypted record before deletion",
        "PRIVATE_REVIEW_CHANGED",
      );
    db.prepare(
      `UPDATE ${kind === "offer" ? "private_sealed_offers" : "private_negotiation_rounds"} SET envelope_json=NULL,deleted_at=? WHERE id=?`,
    ).run(stamp(), id);
    advance(t);
    event(
      t,
      actorId,
      typeof actor === "string" ? "supplier" : "company",
      "encrypted_content_deleted",
      "Razor's active ciphertext copy was deleted; public metadata, commitments, decisions and disclosed final terms remain. Local downloads, backups and provider records are not erased",
      found.invite.id,
    );
    return detail(tender(t.id), typeof actor === "string" ? actor : undefined);
  });
}
export type CompanyPrivateTender = ReturnType<typeof companyDetail>;
