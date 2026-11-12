export function usd(micro: string | bigint = "0"): string {
  const value = BigInt(micro);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = (absolute / 1_000_000n).toLocaleString("en-US");
  const cents = ((absolute % 1_000_000n) / 10_000n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${whole}.${cents}`;
}

export function microUsd(value: string, allowZero = false): string {
  if (!/^\d+(\.\d{1,6})?$/.test(value.trim())) throw new Error("Enter a positive amount with up to six decimal places.");
  const [whole, fraction = ""] = value.trim().split(".");
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (amount === 0n && !allowZero) throw new Error("Enter an amount greater than zero.");
  return amount.toString();
}

export function usdcInput(value: string): string {
  const amount = BigInt(value);
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${amount / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

export function dateLabel(value?: string | null): string {
  if (!value) return "Unscheduled";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
