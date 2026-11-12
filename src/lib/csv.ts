export function parseCsv(source: string): Record<string, string>[] {
  const records: string[][] = [];
  let current: string[] = [], field = "", quoted = false;
  const input = source.replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === '"') {
      if (quoted && input[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { current.push(field.trim()); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && input[index + 1] === "\n") index++;
      current.push(field.trim()); if (current.some(Boolean)) records.push(current); current = []; field = "";
    } else field += char;
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field.");
  current.push(field.trim()); if (current.some(Boolean)) records.push(current);
  if (records.length < 2) throw new Error("CSV needs a header and at least one data row.");
  const headers = records.shift()!.map((value) => value.toLowerCase());
  if (new Set(headers).size !== headers.length || headers.some((value) => !value)) throw new Error("CSV column names must be unique and nonempty.");
  return records.map((record, index) => {
    if (record.length !== headers.length) throw new Error(`CSV row ${index + 2} has the wrong number of columns.`);
    return Object.fromEntries(headers.map((header, column) => [header, record[column]]));
  });
}

export function parsePayrollCsv(source: string, recipients: { id: string; email: string | null }[]): Record<string, string> {
  const items: Record<string, string> = {};
  const records = parseCsv(source);
  if (records.length > 1000) throw new Error("Import up to 1,000 recipients at a time.");
  for (const [index, record] of records.entries()) {
    const recipient = recipients.find((value) => record.recipient_id ? value.id === record.recipient_id : value.email?.toLowerCase() === record.email?.toLowerCase());
    if (!recipient) throw new Error(`Row ${index + 2}: recipient not found. Add or invite this payee first.`);
    if (!/^\d+(\.\d{1,6})?$/.test(record.amount ?? "") || /^0(\.0+)?$/.test(record.amount)) throw new Error(`Row ${index + 2}: enter a positive USDC amount.`);
    if (recipient.id in items) throw new Error(`Row ${index + 2}: recipient appears more than once.`);
    items[recipient.id] = record.amount;
  }
  return items;
}
