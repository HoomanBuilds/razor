import { DestinationError, normalizeDestination } from "../../lib/recipient-destination";
import { nativeUsdc, type Token } from "../payments/intents";
import type { RecipientSnapshot } from "../payments/types";
import { BACKUP_NETWORKS } from "../payments/policy";

export interface RouteSupport {
  status: "supported" | "unsupported" | "unknown" | "invalid";
  network: string;
  assetId: string | null;
  reason: string;
}

function support(network: string, assetId: string, address: string, memo: string | null, tokens: Token[] | null): RouteSupport {
  const base = { network, assetId };
  try {
    if (normalizeDestination(network, address, memo).address !== address) return { ...base, status: "invalid", reason: "The complete encoded address needs recipient reconfirmation" };
  } catch (error) {
    return { ...base, status: error instanceof DestinationError && error.code === "DESTINATION_NETWORK_UNVERIFIED" ? "unknown" : "invalid", reason: error instanceof Error ? error.message : "Check the receiving address" };
  }
  if (!tokens) return { ...base, status: "unknown", reason: "The live asset catalog is unavailable. Routing support is unknown" };
  let token: Token | undefined;
  try { token = assetId === "USDC" ? nativeUsdc(tokens, network) : tokens.find(value => value.assetId === assetId && value.blockchain === network); } catch {}
  return token
    ? { network, assetId: token.assetId, status: "supported", reason: "Asset and address format supported; an executable quote and its limits must still be checked" }
    : { ...base, status: "unsupported", reason: "This exact asset is outside the current catalog on the receiving network" };
}

export function recipientRouteReadiness(profile: RecipientSnapshot, tokens: Token[] | null, disabledBackups: Set<string>) {
  const primary = support(profile.primary_network, profile.primary_asset, profile.primary_address, profile.primary_memo ?? null, tokens);
  let backup: RouteSupport;
  if (!profile.backup_network || !profile.backup_address) backup = { network: profile.backup_network ?? "", assetId: null, status: "unsupported", reason: "No complete USDC backup is recorded" };
  else if (!BACKUP_NETWORKS.includes(profile.backup_network as typeof BACKUP_NETWORKS[number]) || disabledBackups.has(profile.backup_network)) backup = { network: profile.backup_network, assetId: null, status: "unsupported", reason: "The company has not enabled this backup network" };
  else if (!profile.fallback_consent) backup = { network: profile.backup_network, assetId: null, status: "unsupported", reason: "Recipient fallback consent is missing" };
  else backup = support(profile.backup_network, "USDC", profile.backup_address, null, tokens);
  if (backup.status === "supported" && primary.network === backup.network && primary.assetId === backup.assetId) backup = { ...backup, status: "invalid", reason: "A native-USDC primary requires a different backup network" };
  const exceptions: string[] = [];
  if (profile.archived) exceptions.push("The recipient profile is archived");
  if (profile.preference_status !== "confirmed" || !profile.confirmed_at) exceptions.push("Recipient confirmation is required");
  if (primary.status !== "supported") exceptions.push(`Primary: ${primary.reason}`);
  const token = tokens?.find(value => value.assetId === primary.assetId);
  if (token && token.symbol !== "USDC" && (!token.price || !Number.isFinite(Number(token.price)) || Number(token.price) <= 0)) exceptions.push("A usable valuation for the preferred asset is unavailable; execution must wait for verified conversion terms");
  if (backup.status !== "supported") exceptions.push(`Backup: ${backup.reason}`);
  if (primary.status !== "supported" && backup.status === "supported") exceptions.push("Backup needs a permitted primary-failure trigger and exact NEAR authorization; it is not selected by this preview");
  return { primary, backup, exceptions, quoteRequired: true as const, executionReady: false as const };
}
