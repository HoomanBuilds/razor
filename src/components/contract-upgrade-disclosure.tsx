import type { ContractUpgradePolicy } from "@/lib/contract-upgrade-policy";

export function ContractUpgradeDisclosure({ policy }: { policy?: ContractUpgradePolicy | null }) {
  if (!policy) return null;
  return <div className="space-y-2 rounded-lg border bg-muted/40 p-4 text-sm">
    <p className="font-semibold">Configured contract upgrade policy: {policy.upgradable ? "Operator-controlled" : "Immutable"}</p>
    <p className="leading-6">{policy.disclosure}</p>
  </div>;
}
