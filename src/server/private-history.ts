import { z } from "zod";

export const privateHistoryQuery=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(25)});

export function privateHistoryWindow(total:number,input:unknown={}) {
  const query=privateHistoryQuery.parse(input),totalPages=Math.max(1,Math.ceil(total/query.pageSize)),page=Math.min(query.page,totalPages);
  return {page,pageSize:query.pageSize,total,totalPages,hasMore:page<totalPages,offset:(page-1)*query.pageSize};
}
