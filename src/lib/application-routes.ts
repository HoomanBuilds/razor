export function legacyWorkspacePath(query: Record<string, string | string[] | undefined>) {
  const params = new URLSearchParams();
  for (const key of ["company", "section", "payment", "invoice"]) {
    const value = query[key];
    if (typeof value === "string" && value.length <= 512) params.set(key, value);
  }
  return params.size ? `/app?${params}` : null;
}
