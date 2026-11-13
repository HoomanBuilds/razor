"use client";

export interface FundingPageInfo { page: number; pageSize: number; total: number; hasMore: boolean }

export function FundingPagination({ data, loading, onPageChange, label = "Funding history pages" }: { data?: FundingPageInfo | null; loading?: boolean; onPageChange: (page: number) => void; label?: string }) {
  if (!data || data.total === 0) return null;
  const start = (data.page - 1) * data.pageSize;
  return <nav aria-label={label} className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm"><p className="text-xs text-muted-foreground">{start < data.total ? `${start + 1}-${Math.min(start + data.pageSize, data.total)} of ${data.total}` : `No rows on this page. ${data.total} total records.`}</p><div className="flex items-center gap-4"><button type="button" className="text-primary disabled:opacity-50" disabled={!!loading || data.page <= 1} onClick={() => onPageChange(data.page - 1)}>Previous</button><span>Page {data.page}</span><button type="button" className="text-primary disabled:opacity-50" disabled={!!loading || !data.hasMore} onClick={() => onPageChange(data.page + 1)}>Next</button></div></nav>;
}
