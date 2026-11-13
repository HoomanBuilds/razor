import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

export class InvalidCompanyTime extends Error {}

export function companyDate(instant: string, timeZone: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(instant) ? instant : formatInTimeZone(instant, timeZone, "yyyy-MM-dd");
}

export function shiftCalendarMonths(date: string, months: number, anchorDay = Number(date.slice(8)), monthEnd = false): string {
  const year = Number(date.slice(0, 4)), month = Number(date.slice(5, 7)) - 1;
  const target = new Date(Date.UTC(year, month + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(monthEnd ? lastDay : Math.min(anchorDay, lastDay));
  return target.toISOString().slice(0, 10);
}

export function addCompanyMonths(instant: string, months: number, timeZone: string, anchorDay?: number | null, monthEnd = false): string {
  const local = formatInTimeZone(instant, timeZone, "yyyy-MM-dd'T'HH:mm:ss");
  return companyTimeToIso(`${shiftCalendarMonths(local.slice(0, 10), months, anchorDay ?? Number(local.slice(8, 10)), monthEnd)}T${local.slice(11)}`, timeZone);
}

export function companyMonthShift(target: string, original: string, timeZone: string): number {
  const left = companyDate(target, timeZone), right = companyDate(original, timeZone);
  return (Number(left.slice(0, 4)) - Number(right.slice(0, 4))) * 12 + Number(left.slice(5, 7)) - Number(right.slice(5, 7));
}

export function shiftPeriodDate(date: string, months: number) {
  const nextDay = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(8, 10);
  return shiftCalendarMonths(date, months, Number(date.slice(8)), nextDay === "01");
}

export function companyTimeToIso(value: string, timeZone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value))
    throw new InvalidCompanyTime("Choose a complete date and time.");
  const normalized = value.length === 16 ? `${value}:00` : value;
  try {
    const instant = fromZonedTime(normalized, timeZone);
    if (
      !Number.isFinite(instant.getTime()) ||
      formatInTimeZone(instant, timeZone, "yyyy-MM-dd'T'HH:mm:ss") !==
        normalized
    )
      throw new Error();
    return instant.toISOString();
  } catch {
    throw new InvalidCompanyTime(
      `This local time does not exist in ${timeZone}. Choose another time.`,
    );
  }
}

export function addCompanyDays(
  instant: string,
  days: number,
  timeZone: string,
): string {
  const local = formatInTimeZone(instant, timeZone, "yyyy-MM-dd'T'HH:mm:ss");
  const date = new Date(
    Date.parse(`${local.slice(0, 10)}T00:00:00Z`) + days * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  return companyTimeToIso(`${date}T${local.slice(11)}`, timeZone);
}

export function companyCalendarShift(
  target: string,
  original: string,
  timeZone: string,
): number {
  const date = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value
      : formatInTimeZone(value, timeZone, "yyyy-MM-dd");
  return (
    (Date.parse(`${date(target)}T00:00:00Z`) -
      Date.parse(`${date(original)}T00:00:00Z`)) /
    86_400_000
  );
}
