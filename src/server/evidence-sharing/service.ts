import { createHash, randomUUID } from "node:crypto";
import {
  portablePacketSchema,
  type PortablePacket,
} from "../../lib/verification/packet";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt, hashToken, newToken } from "../identity/crypto";
import { getAccess, type SessionRecord } from "../identity/session";
import {
  createShareInput,
  deleteShareInput,
  shareActionInput,
  shareListInput,
  SHARE_MAX_ACTIVE,
  SHARE_MAX_BYTES,
  type ShareRecord,
} from "./model";
import { evidenceShareSource, exportShareSource } from "./sources";

const metadataColumns =
  "id,organization_id,created_by,source_kind,source_id,disclosure,token_hash,request_key_hash,request_hash,packet_sha256,packet_bytes,status,created_at,expires_at,source_expires_at,revoked_at,deleted_at,(packet_ciphertext IS NOT NULL) AS packet_retained";
const now = () => new Date().toISOString();
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unavailable = () =>
  new ApiError(
    404,
    "This evidence link is unavailable",
    "EVIDENCE_SHARE_NOT_FOUND",
  );
function current(access: AccessContext) {
  const live = getAccess(access.userId, access.organizationId);
  requirePermission(live, "company:read");
  return live;
}
function owner(access: AccessContext) {
  return (
    access.permissions.includes("company:manage") &&
    !!row(
      "SELECT id FROM organizations WHERE id=? AND owner_id=?",
      access.organizationId,
      access.userId,
    )
  );
}
function fresh(access: AccessContext, session: SessionRecord) {
  const actual = row<SessionRecord>(
    "SELECT * FROM sessions WHERE id=? AND user_id=? AND expires_at>?",
    session.id,
    access.userId,
    now(),
  );
  const age = actual ? Date.now() - Date.parse(actual.created_at) : NaN;
  if (!actual || !Number.isFinite(age) || age < 0 || age > 900000)
    throw new ApiError(
      403,
      "Verify a linked sign-in method again before creating a public evidence link",
      "FRESH_SIGN_IN_REQUIRED",
    );
}
function event(
  share: ShareRecord,
  actorId: string | null,
  action: string,
  key?: string,
  requestHash?: string,
) {
  getDb()
    .prepare(
      "INSERT INTO evidence_share_events(id,share_id,actor_id,action,request_key_hash,request_hash,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      randomUUID(),
      share.id,
      actorId,
      action,
      key ? hashToken(key) : null,
      requestHash ?? null,
      now(),
    );
}
function invalidate(
  share: ShareRecord,
  status: "expired" | "source_unavailable",
) {
  const result = getDb()
    .prepare(
      "UPDATE evidence_shares SET status=?,packet_ciphertext=NULL WHERE id=? AND status='active'",
    )
    .run(status, share.id);
  if (result.changes) event(share, null, status);
  return { ...share, status, packet_ciphertext: null };
}
function active(share: ShareRecord) {
  if (
    share.status !== "active" ||
    !share.source_id ||
    (!share.packet_ciphertext && !share.packet_retained)
  )
    return false;
  if (share.expires_at <= now()) {
    invalidate(share, "expired");
    return false;
  }
  try {
    const creator = current({
      userId: share.created_by,
      organizationId: share.organization_id,
      permissions: [],
    });
    const source = evidenceShareSource(
      creator,
      share.source_kind,
      share.source_id,
    );
    if (source.expiresAt < share.expires_at || source.expiresAt <= now())
      throw new Error();
    return true;
  } catch {
    invalidate(share, "source_unavailable");
    return false;
  }
}
function summary(share: ShareRecord) {
  return {
    id: share.id,
    sourceKind: share.source_kind,
    sourceId: share.source_id,
    disclosure: share.disclosure,
    status: share.status,
    createdAt: share.created_at,
    expiresAt: share.expires_at,
    sourceExpiresAt: share.source_expires_at,
    revokedAt: share.revoked_at,
    deletedAt: share.deleted_at,
    packetSha256: share.packet_sha256,
    packetBytes: share.packet_bytes,
    tokenReadbackAvailable: false,
    scope:
      "Frozen server-exported portable packet only. Invoice/payroll plaintext, raw documents, replay secrets, credentials and decryption keys are excluded.",
    downloadedCopiesRevocable: false,
  };
}
function owned(access: AccessContext, id: string) {
  const share = row<ShareRecord>(
    `SELECT ${metadataColumns} FROM evidence_shares WHERE id=? AND organization_id=?`,
    id,
    access.organizationId,
  );
  if (!share || (share.created_by !== access.userId && !owner(access)))
    throw new ApiError(
      404,
      "Evidence share not found",
      "EVIDENCE_SHARE_NOT_FOUND",
    );
  return share;
}
function replay(
  share: ShareRecord,
  actorId: string,
  key: string,
  requestHash: string,
) {
  const previous = row<{ request_hash: string }>(
    "SELECT request_hash FROM evidence_share_events WHERE share_id=? AND actor_id=? AND request_key_hash=?",
    share.id,
    actorId,
    hashToken(key),
  );
  if (previous && previous.request_hash !== requestHash)
    throw new ApiError(
      409,
      "This action key already has different terms",
      "EVIDENCE_SHARE_REPLAY_CONFLICT",
    );
  return !!previous;
}
export function purgeEvidenceShares() {
  return transaction(() => {
    const expired = rows<ShareRecord>(
      `SELECT ${metadataColumns} FROM evidence_shares WHERE status='active' AND expires_at<=? ORDER BY expires_at LIMIT 1000`,
      now(),
    );
    for (const share of expired) invalidate(share, "expired");
    return { redacted: expired.length, mayHaveMore: expired.length === 1000 };
  });
}
export function createEvidenceShare(
  access: AccessContext,
  data: unknown,
  session: SessionRecord,
) {
  const input = createShareInput.parse(data),
    requestHash = digest(input);
  return transaction((db) => {
    const live = current(access);
    fresh(live, session);
    const previous = row<ShareRecord>(
      `SELECT ${metadataColumns} FROM evidence_shares WHERE organization_id=? AND created_by=? AND request_key_hash=?`,
      live.organizationId,
      live.userId,
      hashToken(input.idempotencyKey),
    );
    if (previous) {
      if (previous.request_hash !== requestHash)
        throw new ApiError(
          409,
          "This creation key already names different disclosure terms",
          "EVIDENCE_SHARE_REPLAY_CONFLICT",
        );
      active(previous);
      return {
        share: summary(
          row<ShareRecord>(
            `SELECT ${metadataColumns} FROM evidence_shares WHERE id=?`,
            previous.id,
          )!,
        ),
        created: false,
        linkAvailable: false,
        token: null,
        sharePath: null,
        notice:
          "The original share was recovered without another link. Its token is not stored or read back. If you lost the first response, revoke this share and deliberately create a new link.",
      };
    }
    for (const value of rows<ShareRecord>(
      `SELECT ${metadataColumns} FROM evidence_shares WHERE organization_id=? AND status='active'`,
      live.organizationId,
    ))
      active(value);
    if (
      row<{ count: number }>(
        "SELECT COUNT(*) count FROM evidence_shares WHERE organization_id=? AND status='active'",
        live.organizationId,
      )!.count >= SHARE_MAX_ACTIVE
    )
      throw new ApiError(
        429,
        "This company already has ten active evidence links. Revoke one or use a local packet download",
        "EVIDENCE_SHARE_CAPACITY",
      );
    if (
      row<{ count: number }>(
        "SELECT COUNT(*) count FROM evidence_shares WHERE organization_id=?",
        live.organizationId,
      )!.count >= 20000
    )
      throw new ApiError(
        429,
        "Evidence-link history capacity is reached. Existing links, revocation and local downloads remain available",
        "EVIDENCE_SHARE_HISTORY_CAPACITY",
      );
    const source = evidenceShareSource(live, input.sourceKind, input.sourceId),
      createdAt = now(),
      expiresAt = new Date(
        Math.min(
          Date.now() + input.ttlMinutes * 60000,
          Date.parse(source.expiresAt),
        ),
      ).toISOString();
    if (Date.parse(expiresAt) - Date.parse(createdAt) < 300000)
      throw new ApiError(
        409,
        "Less than five minutes of source retention remains. Use the local packet download instead",
        "EVIDENCE_SHARE_SOURCE_EXPIRING",
      );
    const packet = exportShareSource(
        live,
        input.sourceKind,
        input.sourceId,
        input.disclosure,
      ),
      json = JSON.stringify(packet),
      bytes = Buffer.byteLength(json);
    if (bytes > SHARE_MAX_BYTES)
      throw new ApiError(
        413,
        "This packet exceeds the eight-MiB sharing limit. Choose metadata-only disclosure or download the packet locally",
        "EVIDENCE_SHARE_PACKET_TOO_LARGE",
      );
    const token = newToken(),
      id = randomUUID();
    db.prepare(
      "INSERT INTO evidence_shares(id,organization_id,created_by,source_kind,source_id,disclosure,token_hash,request_key_hash,request_hash,packet_ciphertext,packet_sha256,packet_bytes,created_at,expires_at,source_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      live.organizationId,
      live.userId,
      input.sourceKind,
      input.sourceId,
      input.disclosure,
      hashToken(token),
      hashToken(input.idempotencyKey),
      requestHash,
      encrypt(json),
      createHash("sha256").update(json).digest("hex"),
      bytes,
      createdAt,
      expiresAt,
      source.expiresAt,
    );
    const saved = row<ShareRecord>(
      `SELECT ${metadataColumns} FROM evidence_shares WHERE id=?`,
      id,
    )!;
    event(saved, live.userId, "created");
    return {
      share: summary(saved),
      created: true,
      linkAvailable: true,
      token,
      sharePath: `/verify/share/${token}`,
      notice:
        "Anyone possessing this bearer link can fetch the frozen disclosed packet until it becomes unavailable. Revocation stops future fetches, not downloaded copies. Copy the link now; Razor stores only its token hash.",
    };
  });
}
export function listEvidenceShares(access: AccessContext, data: unknown = {}) {
  const input = shareListInput.parse(data);
  return transaction(() => {
    const live = current(access),
      isOwner = owner(live);
    for (const value of rows<ShareRecord>(
      `SELECT ${metadataColumns} FROM evidence_shares WHERE organization_id=? AND status='active'`,
      live.organizationId,
    ))
      active(value);
    const where = "organization_id=? AND (?=1 OR created_by=?)",
      params = [live.organizationId, isOwner ? 1 : 0, live.userId];
    const total = row<{ count: number }>(
      `SELECT COUNT(*) count FROM evidence_shares WHERE ${where}`,
      ...params,
    )!.count;
    return {
      shares: rows<ShareRecord>(
        `SELECT ${metadataColumns} FROM evidence_shares WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET ?`,
        ...params,
        (input.page - 1) * 25,
      ).map(summary),
      page: input.page,
      pageSize: 25,
      total,
      hasMore: input.page * 25 < total,
      activeCompanyShares: row<{ count: number }>(
        "SELECT COUNT(*) count FROM evidence_shares WHERE organization_id=? AND status='active'",
        live.organizationId,
      )!.count,
      maxActiveCompanyShares: SHARE_MAX_ACTIVE,
      maxPacketBytes: SHARE_MAX_BYTES,
      tokenReadbackAvailable: false,
      notice:
        "You can manage your own shares; the current company owner can manage all company shares. Source deletion, expiry or loss of the creator's required access makes a link unavailable. Already downloaded copies cannot be revoked or expired remotely.",
    };
  });
}
export function revokeEvidenceShare(
  access: AccessContext,
  id: string,
  data: unknown,
) {
  const input = shareActionInput.parse(data),
    requestHash = digest({ action: "revoke", ...input });
  return transaction((db) => {
    const live = current(access),
      share = owned(live, id);
    if (replay(share, live.userId, input.idempotencyKey, requestHash))
      return { share: summary(share), replayed: true };
    if (share.status !== "active")
      return { share: summary(share), replayed: true };
    if (share.status === "active")
      db.prepare(
        "UPDATE evidence_shares SET status='revoked',revoked_at=?,packet_ciphertext=NULL WHERE id=?",
      ).run(now(), id);
    event(share, live.userId, "revoked", input.idempotencyKey, requestHash);
    return {
      share: summary(
        row<ShareRecord>(
          `SELECT ${metadataColumns} FROM evidence_shares WHERE id=?`,
          id,
        )!,
      ),
      replayed: false,
    };
  });
}
export function deleteEvidenceShare(
  access: AccessContext,
  id: string,
  data: unknown,
) {
  const input = deleteShareInput.parse(data),
    requestHash = digest({ action: "delete", ...input });
  return transaction((db) => {
    const live = current(access),
      share = owned(live, id);
    if (replay(share, live.userId, input.idempotencyKey, requestHash))
      return { share: summary(share), replayed: true };
    if (share.status === "deleted")
      return { share: summary(share), replayed: true };
    db.prepare(
      "UPDATE evidence_shares SET status='deleted',packet_ciphertext=NULL,source_id=NULL,deleted_at=COALESCE(deleted_at,?),revoked_at=COALESCE(revoked_at,?) WHERE id=?",
    ).run(now(), now(), id);
    event(share, live.userId, "deleted", input.idempotencyKey, requestHash);
    return {
      share: summary(
        row<ShareRecord>(
          `SELECT ${metadataColumns} FROM evidence_shares WHERE id=?`,
          id,
        )!,
      ),
      replayed: false,
    };
  });
}
export function readPublicEvidenceShare(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw unavailable();
  const result = transaction(() => {
    const share = row<ShareRecord>(
      "SELECT * FROM evidence_shares WHERE token_hash=?",
      hashToken(token),
    );
    if (!share || !active(share)) return null;
    let json: string, packet: PortablePacket;
    try {
      json = decrypt(share.packet_ciphertext!);
      if (
        Buffer.byteLength(json) !== share.packet_bytes ||
        Buffer.byteLength(json) > SHARE_MAX_BYTES ||
        createHash("sha256").update(json).digest("hex") !== share.packet_sha256
      )
        throw new Error();
      packet = portablePacketSchema.parse(JSON.parse(json));
      if (
        packet.subject.kind !== share.source_kind ||
        packet.subject.id !== share.source_id ||
        packet.disclosure.mode !== share.disclosure
      )
        throw new Error();
    } catch {
      invalidate(share, "source_unavailable");
      return null;
    }
    return {
      share: {
        id: share.id,
        sourceKind: share.source_kind,
        disclosure: share.disclosure,
        createdAt: share.created_at,
        expiresAt: share.expires_at,
        sourceExpiresAt: share.source_expires_at,
        packetSha256: share.packet_sha256,
        packetBytes: share.packet_bytes,
        scope:
          "Frozen portable packet exported from an authorized company source. No current financial state or cryptographic verification is established by possession of this link.",
        downloadedCopiesRevocable: false,
      },
      packet,
      verification: {
        packetTransport: "server_frozen_snapshot",
        hardware: "not_checked",
        sourceExecution: "not_checked",
        destinationSettlement: "not_checked",
      },
      notice:
        "The original packet describes a local export; this separately authorized bearer link distributes that frozen export. Independently verify any cryptographic claims with separately reviewed trust. Deletion, access loss, expiry and revocation stop future link access; they cannot revoke copied files.",
    };
  });
  if (!result) throw unavailable();
  return result;
}
export type EvidenceSharePage = ReturnType<typeof listEvidenceShares>;
export type EvidenceShareCreation = ReturnType<typeof createEvidenceShare>;
export type PublicEvidenceShare = ReturnType<typeof readPublicEvidenceShare>;
