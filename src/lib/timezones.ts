const cityNames: Record<string, string> = { Calcutta: "Kolkata", Kiev: "Kyiv" };

function city(zone: string) {
  const name = zone.split("/").at(-1) ?? zone;
  return cityNames[name] ?? name.replaceAll("_", " ");
}
function valid(zone: string) {
  try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(); return true; }
  catch { return false; }
}

export function detectedTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}

export function timeZoneOptions(selected?: string, detected?: string) {
  let catalog: string[] = [];
  try { catalog = Intl.supportedValuesOf("timeZone"); } catch {}
  const extra = [selected, detected, "UTC"].filter((zone): zone is string => !!zone && valid(zone));
  const choices = new Map<string, { value: string; label: string }>();
  for (const zone of [...extra, ...catalog]) {
    const region = zone.includes("/") ? zone.split("/")[0].replace("America", "Americas") : "";
    const label = zone === "UTC" ? "Coordinated Universal Time (UTC)" : `${city(zone)}${region ? ` · ${region}` : ""}`;
    if (!choices.has(label)) choices.set(label, { value: zone, label });
  }
  return [...choices.values()].sort((left,right) => left.label.localeCompare(right.label,"en"));
}

export function timeZoneDetails(zone: string, at = new Date()) {
  if (!zone) return null;
  try {
    const part = (timeZoneName: "long" | "shortOffset") => new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName }).formatToParts(at).find(part => part.type === "timeZoneName")?.value ?? "";
    return { city: city(zone), name: part("long"), offset: part("shortOffset").replace("GMT", "UTC") };
  } catch { return null; }
}
