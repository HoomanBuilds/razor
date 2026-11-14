import { base32nopad, base58, base58check, base58xrp, bech32, bech32m } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { getAddress, isAddress } from "viem";


const EVM = new Set(["eth", "base", "arb", "pol", "op", "avax", "bsc", "gnosis", "aurora", "bera", "plasma", "monad", "xlayer", "scroll", "adi", "hood", "hlevm", "hypercore", "linea", "mantle", "blast", "celo", "zksync", "abs"]);
const ALIASES: Record<string, string> = { ethereum: "eth", arbitrum: "arb", polygon: "pol", solana: "sol", optimism: "op", avalanche: "avax", berachain: "bera", bitcoin: "btc", litecoin: "ltc", dogecoin: "doge", bitcoincash: "bch", xlm: "stellar", trx: "tron", bnb: "bsc", quantus: "qtc", pearl: "prl" };
const checked58 = base58check(sha256);
export const usesEvmAddress = (network: string) => EVM.has(canonicalNetwork(network));
export const canonicalNetwork = (network: string) => ALIASES[network.toLowerCase()] ?? network.toLowerCase();

export class DestinationError extends Error {
  constructor(message: string, public code = "INVALID_ADDRESS") { super(message); }
}

function assert(value: unknown): asserts value { if (!value) throw new Error("Invalid destination"); }

function checkedXrp(address: string): Uint8Array {
  const bytes = base58xrp.decode(address), payload = bytes.slice(0, -4);
  assert(bytes.length >= 5 && sha256(sha256(payload)).slice(0, 4).every((byte, index) => byte === bytes[bytes.length - 4 + index]));
  return payload;
}

function xrp(address: string, memo: string | null) {
  let payload = checkedXrp(address);
  if (address.startsWith("X")) {
    assert(payload.length === 31 && payload[0] === 5 && payload[1] === 68 && payload[22] <= 1 && payload.slice(27).every(byte => byte === 0));
    const tag = new DataView(payload.buffer, payload.byteOffset + 23, 4).getUint32(0, true);
    assert(payload[22] === 1 || tag === 0);
    const embedded = payload[22] === 1 ? String(tag) : null;
    if (memo !== null && memo !== embedded) throw new DestinationError("The XRP tag does not match the tag encoded in this X-address", "DESTINATION_TAG_MISMATCH");
    return { address, memo: embedded };
  }
  assert(payload.length === 21 && payload[0] === 0 && address.startsWith("r"));
  if (memo === null) return { address, memo: null };
  if (!/^(0|[1-9]\d{0,9})$/.test(memo) || BigInt(memo) > 4294967295n) throw new DestinationError("Use a whole-number XRP destination tag from 0 to 4294967295", "DESTINATION_TAG_INVALID");
  const encoded = new Uint8Array(31);
  encoded.set([5, 68]); encoded.set(payload.slice(1), 2); encoded[22] = 1;
  new DataView(encoded.buffer).setUint32(23, Number(memo), true);
  payload = new Uint8Array([...encoded, ...sha256(sha256(encoded)).slice(0, 4)]);
  return { address: base58xrp.encode(payload), memo };
}

function crc16(bytes: Uint8Array) {
  let result = 0;
  for (const byte of bytes) {
    result ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) result = (result & 0x8000 ? (result << 1) ^ 0x1021 : result << 1) & 0xffff;
  }
  return result;
}

function witness(address: string, prefix: string) {
  let decoded;
  try { decoded = bech32.decode(address as `${string}1${string}`); assert(decoded.words[0] === 0); }
  catch { decoded = bech32m.decode(address as `${string}1${string}`); assert(decoded.words[0] > 0 && decoded.words[0] <= 16); }
  const bytes = bech32.fromWords(decoded.words.slice(1));
  assert(decoded.prefix === prefix && bytes.length >= 2 && bytes.length <= 40 && (decoded.words[0] !== 0 || bytes.length === 20 || bytes.length === 32));
}

function quantus(address: string) {
  const bytes = base58.decode(address);
  assert(bytes.length === 36 && bytes[0] === 0x6f && bytes[1] === 0x40);
  const payload = bytes.slice(0, 34);
  const checksum = blake2b(new Uint8Array([...new TextEncoder().encode("SS58PRE"), ...payload]), { dkLen: 64 });
  assert(bytes[34] === checksum[0] && bytes[35] === checksum[1]);
}

function pearl(address: string) {
  const decoded = bech32m.decode(address as `${string}1${string}`);
  assert(decoded.prefix === "prl" && decoded.words[0] === 1 && bech32m.fromWords(decoded.words.slice(1)).length === 32);
}

function miden(address: string) {
  assert(address === address.toLowerCase() || address === address.toUpperCase());
  const [identifier, routing, ...extra] = address.toLowerCase().split("_");
  assert(extra.length === 0);
  const decoded = bech32m.decodeToBytes(identifier, 200);
  assert(decoded.prefix === "mm");
  if (decoded.bytes[0] !== 232 || decoded.bytes.length !== 16) throw new DestinationError("Copy a current mainnet Miden basic-wallet address beginning mm1a from your wallet. Legacy address formats are not supported.", "DESTINATION_ADDRESS_FORMAT_UNSUPPORTED");
  const id = decoded.bytes.slice(1), prefix = id.slice(0, 8).reduce((value, byte) => value * 256n + BigInt(byte), 0n);
  assert(prefix < 0xffffffff00000001n && id[8] < 128);
  if ((id[7] & 15) !== 1) throw new DestinationError("Copy an updated mainnet Miden basic-wallet address from a current wallet. This account address uses an unsupported legacy version.", "DESTINATION_ADDRESS_FORMAT_UNSUPPORTED");
  if (routing !== undefined) {
    assert(routing.length > 0);
    const parameters = bech32m.decodeToBytes(`mrp1${routing}`, 200).bytes;
    if (parameters.length !== 3 || parameters[0] !== 0) throw new DestinationError("Use a mainnet Miden basic-wallet address without encryption-key or unknown routing parameters. Razor never removes routing instructions from your address.", "DESTINATION_METADATA_UNSUPPORTED");
    const profile = parameters[1] * 256 + parameters[2], tagLength = profile >> 10;
    if ((profile & 1023) !== 0) throw new DestinationError("Use a current mainnet Miden address for the BasicWallet interface.", "DESTINATION_ADDRESS_FORMAT_UNSUPPORTED");
    assert(tagLength <= 32 || tagLength === 63);
  }
}

function cashAddress(address: string) {
  const value = address.includes(":") ? address : `bitcoincash:${address}`;
  assert(value === value.toLowerCase() || value === value.toUpperCase());
  const [prefix, payload] = value.toLowerCase().split(":");
  assert(prefix === "bitcoincash" && payload?.length === 42);
  const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l", words = [...payload].map(char => alphabet.indexOf(char));
  assert(words.every(word => word >= 0));
  let checksum = 1n;
  const generators = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  for (const word of [...prefix].map(char => char.charCodeAt(0) & 31).concat(0, ...words)) {
    const top = checksum >> 35n; checksum = ((checksum & 0x07ffffffffn) << 5n) ^ BigInt(word);
    generators.forEach((generator, index) => { if ((top >> BigInt(index)) & 1n) checksum ^= generator; });
  }
  assert(checksum === 1n);
  const bytes = bech32.fromWords(words.slice(0, -8));
  assert(bytes.length === 21 && [0, 8].includes(bytes[0]));
}


export function normalizeDestination(networkInput: string, addressInput: string, memoInput?: string | null): { address: string; memo: string | null } {
  const network = canonicalNetwork(networkInput), address = addressInput.trim(), memo = memoInput?.trim() || null;
  if (!address || address.length > 200 || /\s/.test(address)) throw new DestinationError("Enter a complete receiving address without spaces");
  if (memo !== null && network !== "xrp") throw new DestinationError(`A separate receiving memo or tag is unsupported on ${network}. Use a personal wallet without that requirement, or choose another supported destination.`, "DESTINATION_METADATA_UNSUPPORTED");
  try {
    if (network === "xrp") return xrp(address, memo);
    if (EVM.has(network)) { assert(isAddress(address)); return { address: getAddress(address).toLowerCase(), memo: null }; }
    if (network === "near") assert(address.length >= 2 && address.length <= 64 && /^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$/.test(address));
    else if (network === "qtc") quantus(address);
    else if (network === "prl") pearl(address);
    else if (network === "miden") miden(address);
    else if (network === "sol" || network === "fogo") assert(base58.decode(address).length === 32);
    else if (["sui", "aptos", "movement"].includes(network)) assert(/^0x[0-9a-fA-F]{64}$/.test(address));
    else if (network === "starknet") assert(/^0x[0-9a-fA-F]{1,64}$/.test(address) && BigInt(address) > 0n && BigInt(address) < 2n ** 251n);
    else if (["btc", "ltc", "doge", "dash", "zec", "bch"].includes(network)) {
      if ((network === "btc" && /^bc1/i.test(address)) || (network === "ltc" && /^ltc1/i.test(address))) witness(address, network === "btc" ? "bc" : "ltc");
      else if (network === "bch" && /^(bitcoincash:)?[qp]/i.test(address)) cashAddress(address);
      else {
        const bytes = checked58.decode(address);
        const versions: Record<string, number[]> = { btc: [0, 5], ltc: [48, 50, 5], doge: [30, 22], dash: [76, 16], bch: [0, 5] };
        if (network === "zec") assert(bytes.length === 22 && bytes[0] === 0x1c && [0xb8, 0xbd].includes(bytes[1]));
        else assert(bytes.length === 21 && versions[network].includes(bytes[0]));
      }
    } else if (network === "tron") { const bytes = checked58.decode(address); assert(bytes.length === 21 && bytes[0] === 0x41); }
    else if (network === "stellar") {
      const bytes = base32nopad.decode(address); assert(address.length === 56 && bytes.length === 35 && bytes[0] === 48);
      assert(crc16(bytes.slice(0, -2)) === bytes[33] + bytes[34] * 256);
    } else if (network === "ton") {
      if (!/^(0|-1):[0-9a-fA-F]{64}$/.test(address)) {
        const bytes = Uint8Array.from(atob(address.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
        assert(bytes.length === 36 && [0x11, 0x51].includes(bytes[0]) && [0, 255].includes(bytes[1]));
        assert(crc16(bytes.slice(0, -2)) === bytes[34] * 256 + bytes[35]);
      }
    } else if (network === "aleo" || network === "cardano") {
      const value = bech32.decodeToBytes(address, 200);
      if (network === "aleo") assert(value.prefix === "aleo" && value.bytes.length === 32);
      else assert(value.prefix === "addr" && (value.bytes[0] & 15) === 1 && ([0, 1, 2, 3].includes(value.bytes[0] >> 4) ? value.bytes.length === 57 : [6, 7].includes(value.bytes[0] >> 4) && value.bytes.length === 29));
    } else throw new DestinationError(`Address validation for ${network} is not enabled yet. Choose a validated destination or ask the payer to hold this payment.`, "DESTINATION_NETWORK_UNVERIFIED");
    return { address, memo: null };
  } catch (error) {
    if (error instanceof DestinationError) throw error;
    throw new DestinationError(`Enter a valid mainnet ${network} receiving address. Check its network, checksum and required routing details.`);
  }
}
