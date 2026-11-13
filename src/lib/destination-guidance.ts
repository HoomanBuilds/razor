export function destinationGuidance(network: string) {
  if (network === "xrp") return "Use an XRP classic address without a tag, or provide its numeric tag. Razor encodes the tag into the X-address used for payment. An existing X-address fixes the tag; use the classic address to change it.";
  if (network === "stellar" || network === "ton") return "Use a personal receiving wallet that does not require a separate memo or comment. NEAR Intents does not expose a receiving memo field for this route.";
  return "Use a receiving address on this exact network. Separate destination memos are not supported on this route.";
}
