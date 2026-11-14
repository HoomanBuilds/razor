export interface ContractUpgradePolicy {
  mode: "immutable" | "owner_controlled";
  upgradable: boolean;
  publicKeys: string[];
  disclosure: string;
}
