const MAX_ATOMIC = (1n << 128n) - 1n;

export function atomic(value: string | bigint, allowZero = false): bigint {
  const text = String(value);
  if (!/^(0|[1-9]\d*)$/.test(text)) throw new Error("Amounts must use unsigned integer base units");
  const amount = BigInt(text);
  if ((!allowZero && amount === 0n) || amount > MAX_ATOMIC) throw new Error("Amount is outside the supported range");
  return amount;
}

export function parseUnits(value: string, decimals = 6): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) throw new Error("Invalid token decimals");
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value.trim());
  if (!match || (match[2]?.length ?? 0) > decimals) throw new Error(`Use an amount with at most ${decimals} decimal places`);
  return atomic(`${match[1]}${(match[2] ?? "").padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, ""), true).toString();
}

export function formatUnits(value: string, decimals = 6): string {
  const amount = atomic(value, true).toString().padStart(decimals + 1, "0");
  if (decimals === 0) return amount;
  return `${amount.slice(0, -decimals)}.${amount.slice(-decimals)}`.replace(/\.?0+$/, "");
}

export function usdToToken(amount: string, price: string | number, decimals: number): string {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(price));
  if (!match || !Number.isInteger(decimals) || decimals < 0 || decimals > 38) throw new Error("Token valuation unavailable");
  const exponent = Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  if (Math.abs(exponent) > 100) throw new Error("Token valuation unavailable");
  const coefficient = BigInt(match[1] + (match[2] ?? ""));
  if (coefficient <= 0n) throw new Error("Token valuation unavailable");
  const numerator = atomic(amount) * 10n ** BigInt(decimals) * (exponent < 0 ? 10n ** BigInt(-exponent) : 1n);
  const denominator = 1_000_000n * coefficient * (exponent > 0 ? 10n ** BigInt(exponent) : 1n);
  return atomic((numerator + denominator - 1n) / denominator).toString();
}
