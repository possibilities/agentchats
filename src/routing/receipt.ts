import * as z from "zod/v4";

const short = z.string().min(1).max(256);
const refs = z.array(short).max(8);
const base = {
  schema_version: z.literal(1),
  decision_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
};

/** Authored rationale and acceptance, never inferred private reasoning or telemetry. */
export const routingReceiptSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...base,
    kind: z.literal("decision"),
    action: z.enum(["direct", "delegate", "reuse", "escalate"]),
    task: z.string().min(1).max(600),
    reason: z.string().min(1).max(600),
    target: short.optional(),
    requested: z.strictObject({
      model: short.nullable(),
      effort: short.nullable(),
      context: short.nullable(),
      service_tier: short.nullable(),
    }),
    evidence_refs: refs,
    policy_ref: short.optional(),
  }).refine((value) => value.action === "direct" || value.target !== undefined, {
    message: "Delegation, reuse and escalation need the exact native task name or target.",
  }),
  z.strictObject({
    ...base,
    kind: z.literal("acceptance"),
    verdict: z.enum(["pending", "accepted", "rejected"]),
    reason: z.string().min(1).max(600),
    evidence_refs: refs,
    presentation: z.enum(["unknown", "pending", "presented"]),
  }).refine((value) => value.verdict !== "accepted" || value.evidence_refs.length > 0, {
    message: "Accepted work needs an evidence reference.",
  }),
]);

export type RoutingReceipt = z.infer<typeof routingReceiptSchema>;

export function parseReceipt(value: unknown): RoutingReceipt {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 8192) throw new Error("Receipt exceeds 8 KiB");
    value = JSON.parse(value);
  }
  return routingReceiptSchema.parse(value);
}

export function receiptResult(value: unknown) {
  return { routing_receipt: parseReceipt(value) };
}
