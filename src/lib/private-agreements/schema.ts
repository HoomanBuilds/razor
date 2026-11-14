import { z } from "zod";
import {
  commercialInput,
  commercialTotals,
} from "../../server/procurement/commercial";

export const digestInput = z.string().regex(/^[a-f0-9]{64}$/);
export const identifier = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
export const quantity = z.string().regex(/^[1-9]\d{0,11}$/);
export const amount = z
  .string()
  .regex(/^[1-9]\d{0,30}$/)
  .refine(
    (value) => /^[1-9]\d{0,30}$/.test(value) && BigInt(value) <= 10n ** 30n,
  );
const text = z.string().trim().min(3).max(3000),
  encoded = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const publicKeySchema = z
  .object({
    kty: z.literal("RSA"),
    n: encoded.length(512),
    e: z.literal("AQAB"),
    alg: z.literal("RSA-OAEP-256"),
    ext: z.literal(true),
    key_ops: z.tuple([z.literal("encrypt")]),
  })
  .strict();
export const keyBundleSchema = z
  .object({
    schema: z.literal("razor.agreement-local-key"),
    version: z.literal(1),
    keyId: digestInput,
    publicKey: publicKeySchema,
    privateKey: publicKeySchema
      .omit({ key_ops: true })
      .extend({
        key_ops: z.tuple([z.literal("decrypt")]),
        d: encoded.max(520),
        p: encoded.max(260),
        q: encoded.max(260),
        dp: encoded.max(260),
        dq: encoded.max(260),
        qi: encoded.max(260),
      })
      .strict(),
  })
  .strict();
export const tenderTermsSchema = z
  .object({
    reference: z.string().trim().min(1).max(120),
    specification: text,
    eligibility: text,
    quantity,
    minimumQuantity: quantity,
    unit: z.string().trim().min(1).max(40),
    budget: amount,
    deliveryFrom: z.string().date(),
    deliveryTo: z.string().date(),
    bidDeadline: z.string().datetime(),
    revealAt: z.string().datetime(),
    negotiationDeadline: z.string().datetime(),
    awardRule: text,
    disclosureRule: z.literal("selected_terms_to_razor_after_buyer_review"),
    revealRule: z.literal("buyer_explicitly_after_reveal_at"),
    encryptedRetentionDays: z.number().int().min(1).max(30),
    reviewingRoleId: identifier,
  })
  .strict();
export const createTenderSchema = z
  .object({
    terms: tenderTermsSchema,
    supplierIds: z.array(identifier).min(1).max(20),
    buyerPublicKey: publicKeySchema,
  })
  .strict();
export const offerTermsSchema = z
  .object({
    quantity,
    unitPrice: amount,
    deliveryDate: z.string().date(),
    validUntil: z.string().datetime(),
    terms: text,
    commercial: commercialInput,
  })
  .strict();
export const mandateTermsSchema = z
  .object({
    maximumTotal: amount,
    minimumQuantity: quantity,
    maximumQuantity: quantity,
    deliveryFrom: z.string().date(),
    deliveryTo: z.string().date(),
    expiresAt: z.string().datetime(),
    maximumRounds: z.number().int().min(1).max(8),
    instruction: text,
  })
  .strict();
export const bindingSchema = z
  .object({
    schema: z.literal("razor.sealed-agreement"),
    organizationId: identifier,
    tenderId: identifier,
    tenderVersion: z.number().int().positive(),
    tenderHash: digestInput,
    inviteId: identifier,
    supplierUserId: identifier,
    supplierVersion: z.number().int().positive(),
    revision: z.number().int().min(1).max(40),
    phase: z.enum(["offer", "negotiation"]),
    mandateId: identifier.nullable(),
    author: z.enum(["company", "supplier"]),
  })
  .strict();
export const envelopeSchema = z
  .object({
    schema: z.literal("razor.sealed-agreement-envelope"),
    version: z.literal(1),
    algorithm: z.literal("RSA-OAEP-3072-SHA256+A256GCM"),
    binding: bindingSchema,
    commitment: digestInput,
    iv: encoded.length(16),
    ciphertext: encoded.min(24).max(100000),
    wrappedKeys: z
      .array(
        z.object({ keyId: digestInput, value: encoded.length(512) }).strict(),
      )
      .min(1)
      .max(2),
  })
  .strict();
export const openedSchema = z
  .object({ terms: offerTermsSchema, salt: encoded.length(43) })
  .strict();
export const privateJobSchema = z
  .object({
    schema: z.literal("razor.private-agreement-job"),
    version: z.literal(1),
    envelope: envelopeSchema,
    tender: tenderTermsSchema,
    buyerPublicKey: publicKeySchema,
    mandate: z
      .object({
        id: identifier,
        state: z.literal("approved"),
        terms: mandateTermsSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export const localReviewSchema = z
  .object({
    schema: z.literal("razor.private-agreement-review"),
    version: z.literal(1),
    binding: bindingSchema,
    commitment: digestInput,
    opened: openedSchema,
    suggestedTerms: offerTermsSchema.optional(),
    inference: z
      .object({
        provider: z.literal("NEAR AI Cloud"),
        model: z.string().max(256),
        reportedVerifiedAt: z.string().datetime(),
        reportedRequestWireHash: digestInput.nullable(),
        reportedResponseWireHash: digestInput.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TenderTerms = z.infer<typeof tenderTermsSchema>;
export type OfferTerms = z.infer<typeof offerTermsSchema>;
export type MandateTerms = z.infer<typeof mandateTermsSchema>;
export type SealedBinding = z.infer<typeof bindingSchema>;
export type SealedEnvelope = z.infer<typeof envelopeSchema>;
export type LocalKey = z.infer<typeof keyBundleSchema>;
export type OpenedOffer = z.infer<typeof openedSchema>;

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined)
    throw new Error("Use defined JSON agreement values");
  return result;
}

export function checkedOffer(
  tender: TenderTerms,
  input: unknown,
  mandate?: MandateTerms,
) {
  const terms = offerTermsSchema.parse(input),
    commercial = commercialTotals(
      terms.quantity,
      terms.unitPrice,
      terms.commercial,
    );
  if (
    BigInt(terms.quantity) < BigInt(tender.minimumQuantity) ||
    BigInt(terms.quantity) > BigInt(tender.quantity) ||
    BigInt(commercial.commercialTotal) > BigInt(tender.budget) ||
    terms.deliveryDate < tender.deliveryFrom ||
    terms.deliveryDate > tender.deliveryTo
  )
    throw new Error(
      "The exact offer exceeds the tender's quantity, price or delivery limits",
    );
  if (
    mandate &&
    (BigInt(commercial.commercialTotal) > BigInt(mandate.maximumTotal) ||
      BigInt(terms.quantity) < BigInt(mandate.minimumQuantity) ||
      BigInt(terms.quantity) > BigInt(mandate.maximumQuantity) ||
      terms.deliveryDate < mandate.deliveryFrom ||
      terms.deliveryDate > mandate.deliveryTo)
  )
    throw new Error(
      "The proposal exceeds the independently authorized negotiation mandate",
    );
  return { terms, commercial, total: commercial.commercialTotal };
}
