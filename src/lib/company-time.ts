import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

export class InvalidCompanyTime extends Error {}

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
