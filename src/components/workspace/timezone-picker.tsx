"use client";

import { useEffect, useMemo, useState } from "react";
import { detectedTimeZone, timeZoneDetails, timeZoneOptions } from "@/lib/timezones";
import { control } from "./shared";

export function TimezonePicker({ name = "timezone", defaultValue, disabled = false, required = true }: { name?: string; defaultValue?: string; disabled?: boolean; required?: boolean }) {
  const [selected, setSelected] = useState(defaultValue ?? "UTC");
  const [detected, setDetected] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const local = detectedTimeZone();
    setDetected(local);
    setSelected(defaultValue ?? local);
    setReady(true);
  }, [defaultValue]);
  const options = useMemo(() => ready ? timeZoneOptions(defaultValue, detected) : [{value:defaultValue ?? "UTC",label:defaultValue ? "Your company time zone" : "Detecting your time zone..."}], [defaultValue, detected, ready]);
  const details = ready ? timeZoneDetails(selected) : null;
  return <span className="grid min-w-0 gap-2">
    <select name={name} value={selected} disabled={disabled || !ready} required={required} className={`${control} razor-native-picker`} onChange={event => setSelected(event.target.value)}>
      {!options.some(option => option.value === selected) && <option value="">Choose a time zone</option>}
      {options.map(option => <option key={option.value} value={option.value}>{option.label}{!defaultValue && option.value === detected ? " (detected)" : ""}</option>)}
    </select>
    {details && <span className="text-[11px] font-normal leading-5 text-muted-foreground">{details.name} · {details.offset}</span>}
  </span>;
}
