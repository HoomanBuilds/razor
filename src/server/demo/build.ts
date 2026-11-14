import type { PublicDemoBuildIdentity } from "./identity";

export function demoBuildIdentity(): PublicDemoBuildIdentity {
  const state = process.env.NEXT_PUBLIC_RAZOR_SOURCE_STATE;
  return {
    ...(state !== "modified" && process.env.NEXT_PUBLIC_RAZOR_SOURCE_REVISION
      ? { sourceRevision: process.env.NEXT_PUBLIC_RAZOR_SOURCE_REVISION }
      : {}),
    publisher:
      state === "modified"
        ? "Local build with uncommitted source changes; exact source revision unavailable"
        : "Build metadata supplied by this application; not independent release attestation",
    ...(process.env.NEXT_PUBLIC_RAZOR_BUILT_AT
      ? { builtAt: process.env.NEXT_PUBLIC_RAZOR_BUILT_AT }
      : {}),
    contractStateVersions: { treasury: 3, clearing: 2, billing: 1, credit: 1 },
  };
}
