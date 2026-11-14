export function destinationGuidance(network: string) {
  if (network === "miden") return "Copy a current mainnet Miden basic-wallet address beginning mm1a. Legacy mm1q addresses, raw hex account IDs, encryption-key routing and unknown wallet interfaces are not accepted. A bare mm1a account ID does not declare its wallet interface; confirm it in your wallet. Keep any supported basic-wallet routing suffix intact. A live quote must still accept the destination and route.";
  if (network === "qtc" || network === "quantus") return "Use a Quantus mainnet account with SS58 prefix 189. Quantus test networks share that address format, so the checksum alone cannot confirm mainnet. Check the network in your own wallet. The QTC symbol alone does not identify the network.";
  if (network === "prl" || network === "pearl") return "Use a Pearl mainnet Taproot address beginning prl1p. Testnet tprl addresses and other address types are not accepted.";
  if (network === "xrp") return "Use an XRP classic address without a tag, or provide its numeric tag. Razor encodes the tag into the X-address used for payment. An existing X-address fixes the tag; use the classic address to change it.";
  if (network === "stellar" || network === "ton") return "Use a personal receiving wallet that does not require a separate memo or comment. NEAR Intents does not expose a receiving memo field for this route.";
  return "Use a receiving address on this exact network. Separate destination memos are not supported on this route.";
}
