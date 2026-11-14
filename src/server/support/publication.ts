import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../context";
import { row, rows, transaction } from "../db";
import { hashToken } from "../identity/crypto";
import { digest } from "./model";
import { isSupportOperator, requireSupportOperator } from "./operators";

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(5)
    .max(max)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const coverage = z
  .object({
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.days).size === value.days.length &&
      value.endMinute > value.startMinute,
    "Use unique weekdays and a same-day ordered coverage interval",
  );
export const supportPublicationInput = z
  .object({
    channel: z.literal("private_ticket"),
    timezone: z
      .string()
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value }).format();
          return true;
        } catch {
          return false;
        }
      }),
    coverage: z.array(coverage).min(1).max(14),
    responseTargetMinutes: z.number().int().min(15).max(43200).nullable(),
    targetBasis: z.literal("staffed_coverage_minutes"),
    capacityBasis: z.literal("utc_calendar_day"),
    expiresAt: z.iso
      .datetime()
      .transform((value) => new Date(value).toISOString()),
    notice: text(600),
    staff: z
      .array(
        z
          .object({
            userId: z.string().min(1).max(128),
            dailyCaseCapacity: z.number().int().min(1).max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    noSlaAcknowledged: z.literal(true),
    noOutboundNotificationsAcknowledged: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expiry = Date.parse(value.expiresAt);
    if (expiry <= Date.now() || expiry > Date.now() + 90 * 86400000)
      ctx.addIssue({
        code: "custom",
        message: "Choose an expiry within the next ninety days",
      });
    if (
      new Set(value.staff.map((staff) => staff.userId)).size !==
      value.staff.length
    )
      ctx.addIssue({
        code: "custom",
        message: "List each accepting operator once",
      });
    for (let day = 1; day <= 7; day++) {
      const windows = value.coverage
        .filter((window) => window.days.includes(day))
        .sort((a, b) => a.startMinute - b.startMinute);
      if (
        windows.some(
          (window, index) =>
            index > 0 && window.startMinute < windows[index - 1].endMinute,
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Coverage intervals must not overlap",
        });
    }
  });
type Terms = z.infer<typeof supportPublicationInput>;
interface Publication {
  id: string;
  version: number;
  terms_json: string;
  terms_hash: string;
  status: "draft" | "published" | "withdrawn";
  created_by: string;
  created_at: string;
  published_at: string | null;
  withdrawn_at: string | null;
}
const now = () => new Date().toISOString();
function publication(id: string) {
  const value = row<Publication>(
    "SELECT * FROM support_staffing_publications WHERE id=?",
    id,
  );
  if (!value)
    throw new ApiError(
      404,
      "Staffing publication not found",
      "SUPPORT_PUBLICATION_NOT_FOUND",
    );
  return value;
}
function acceptance(value: Publication) {
  const terms = JSON.parse(value.terms_json) as Terms;
  return terms.staff.map((staff) => {
    const latest = row<{
      accepted: number;
      terms_hash: string;
      created_at: string;
    }>(
      "SELECT accepted,terms_hash,created_at FROM support_staff_acknowledgments WHERE publication_id=? AND user_id=? ORDER BY sequence DESC LIMIT 1",
      value.id,
      staff.userId,
    );
    return {
      ...staff,
      accepted:
        !!latest?.accepted &&
        latest.terms_hash === value.terms_hash &&
        isSupportOperator(staff.userId),
      acknowledgedAt: latest?.created_at ?? null,
    };
  });
}
function projected(value: Publication) {
  return {
    id: value.id,
    version: value.version,
    terms: JSON.parse(value.terms_json) as Terms,
    termsHash: value.terms_hash,
    status: value.status,
    createdAt: value.created_at,
    publishedAt: value.published_at,
    staff: acceptance(value),
  };
}
export function listSupportPublications(userId: string, page = 1) {
  requireSupportOperator(userId);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
    throw new ApiError(
      422,
      "Choose a valid publication page",
      "SUPPORT_PAGE_INVALID",
    );
  return {
    page,
    publications: rows<Publication>(
      "SELECT * FROM support_staffing_publications ORDER BY version DESC LIMIT 25 OFFSET ?",
      (page - 1) * 25,
    ).map(projected),
  };
}
export function proposeSupportPublication(userId: string, input: unknown) {
  requireSupportOperator(userId);
  const terms = supportPublicationInput.parse(input);
  for (const staff of terms.staff) requireSupportOperator(staff.userId);
  return transaction((db) => {
    const id = randomUUID(),
      version =
        (row<{ version: number }>(
          "SELECT MAX(version) version FROM support_staffing_publications",
        )?.version ?? 0) + 1;
    db.prepare(
      "INSERT INTO support_staffing_publications(id,version,terms_json,terms_hash,created_by,created_at) VALUES(?,?,?,?,?,?)",
    ).run(id, version, JSON.stringify(terms), digest(terms), userId, now());
    db.prepare(
      "INSERT INTO support_publication_events(publication_id,user_id,action,created_at) VALUES(?,?,?,?)",
    ).run(id, userId, "drafted", now());
    return projected(publication(id));
  });
}
export function acknowledgeSupportPublication(
  userId: string,
  id: string,
  data: unknown,
) {
  requireSupportOperator(userId);
  const input = z
      .object({
        idempotencyKey: z.string().uuid(),
        termsHash: z.string().regex(/^[0-9a-f]{64}$/),
        accepted: z.boolean(),
      })
      .strict()
      .parse(data),
    requestHash = digest({ id, ...input });
  return transaction((db) => {
    const value = publication(id),
      terms = JSON.parse(value.terms_json) as Terms;
    const previous = row<{ request_hash: string }>(
      "SELECT request_hash FROM support_staff_acknowledgments WHERE user_id=? AND idempotency_key=?",
      userId,
      hashToken(input.idempotencyKey),
    );
    if (previous) {
      if (previous.request_hash !== requestHash)
        throw new ApiError(
          409,
          "This acknowledgment identity has different terms",
          "SUPPORT_REPLAY_CONFLICT",
        );
      return projected(value);
    }
    if (
      value.terms_hash !== input.termsHash ||
      !terms.staff.some((staff) => staff.userId === userId)
    )
      throw new ApiError(
        403,
        "Only the exact named operator may accept these reviewed staffing terms",
        "SUPPORT_STAFF_ACK_REQUIRED",
      );
    if (
      input.accepted &&
      (value.status === "withdrawn" || terms.expiresAt <= now())
    )
      throw new ApiError(
        409,
        "This publication is withdrawn or expired",
        "SUPPORT_PUBLICATION_UNAVAILABLE",
      );
    db.prepare(
      "INSERT INTO support_staff_acknowledgments(id,publication_id,user_id,terms_hash,accepted,request_hash,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      id,
      userId,
      value.terms_hash,
      input.accepted ? 1 : 0,
      requestHash,
      hashToken(input.idempotencyKey),
      now(),
    );
    db.prepare(
      "INSERT INTO support_publication_events(publication_id,user_id,action,created_at) VALUES(?,?,?,?)",
    ).run(
      id,
      userId,
      input.accepted ? "staff_accepted" : "staff_withdrew",
      now(),
    );
    return projected(value);
  });
}
export function publishSupportCoverage(
  userId: string,
  id: string,
  termsHash: string,
) {
  requireSupportOperator(userId);
  return transaction((db) => {
    const value = publication(id),
      terms = JSON.parse(value.terms_json) as Terms;
    if (
      value.terms_hash !== termsHash ||
      value.status !== "draft" ||
      terms.expiresAt <= now() ||
      acceptance(value).some((staff) => !staff.accepted)
    )
      throw new ApiError(
        409,
        "Publish only the unexpired exact draft after every configured named operator accepts its capacity, coverage and response target",
        "SUPPORT_STAFF_ACK_REQUIRED",
      );
    db.prepare(
      "UPDATE support_staffing_publications SET status='withdrawn',withdrawn_at=? WHERE status='published'",
    ).run(now());
    db.prepare(
      "UPDATE support_staffing_publications SET status='published',published_at=? WHERE id=?",
    ).run(now(), id);
    db.prepare(
      "INSERT INTO support_publication_events(publication_id,user_id,action,created_at) VALUES(?,?,?,?)",
    ).run(id, userId, "published", now());
    return projected(publication(id));
  });
}
export function withdrawSupportCoverage(userId: string, id: string) {
  requireSupportOperator(userId);
  return transaction((db) => {
    const value = publication(id);
    db.prepare(
      "UPDATE support_staffing_publications SET status='withdrawn',withdrawn_at=COALESCE(withdrawn_at,?) WHERE id=?",
    ).run(now(), value.id);
    db.prepare(
      "INSERT INTO support_publication_events(publication_id,user_id,action,created_at) VALUES(?,?,?,?)",
    ).run(id, userId, "withdrawn", now());
    return projected(publication(id));
  });
}
export function publicSupportPublication() {
  const value = row<Publication>(
      "SELECT * FROM support_staffing_publications WHERE status='published'",
    ),
    terms = value ? (JSON.parse(value.terms_json) as Terms) : null;
  const staff = value ? acceptance(value) : [];
  const ready =
    !!value &&
    !!terms &&
    terms.expiresAt > now() &&
    staff.every((staff) => staff.accepted);
  let withinCoverage = false;
  if (ready && terms) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: terms.timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts();
    const part = (type: string) =>
        parts.find((part) => part.type === type)?.value ?? "",
      day =
        ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
          part("weekday"),
        ) + 1,
      minute = Number(part("hour")) * 60 + Number(part("minute"));
    withinCoverage = terms.coverage.some(
      (window) =>
        window.days.includes(day) &&
        minute >= window.startMinute &&
        minute < window.endMinute,
    );
  }
  return {
    checkedAt: now(),
    intake: {
      channel: "private_ticket" as const,
      asynchronous: true,
      staffResponseGuaranteed: false,
      serviceLevelAgreement: false,
      outboundNotifications: false,
      transferRecoveryPaywalled: false,
    },
    staffing:
      ready && value && terms
        ? {
            available: true as const,
            publicationId: value.id,
            version: value.version,
            termsHash: value.terms_hash,
            timezone: terms.timezone,
            coverage: terms.coverage,
            withinCoverage,
            responseTargetMinutes: terms.responseTargetMinutes,
            targetBasis: terms.targetBasis,
            capacityBasis: terms.capacityBasis,
            dailyCaseCapacity: staff.reduce(
              (sum, item) => sum + item.dailyCaseCapacity,
              0,
            ),
            acceptedOperatorCount: staff.length,
            expiresAt: terms.expiresAt,
            notice: terms.notice,
          }
        : {
            available: false as const,
            reason:
              "No current publication has unexpired coverage accepted by every configured support operator. Asynchronous private ticket intake remains available; no staffed response target is advertised.",
          },
    notice:
      "Published response targets are operational aims during stated coverage, not guarantees. Capacity and staff acknowledgment do not prove a particular case was read. Escalations stay queued until an operator explicitly acknowledges them; do not retry an unknown transfer.",
  };
}
export type PublicSupportPublication = ReturnType<
  typeof publicSupportPublication
>;
