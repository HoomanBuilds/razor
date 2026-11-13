import { z } from "zod";
import { ApiError } from "./context";

export const paginationInput = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) });
export function pageWindow(page: number, pageSize: number) {
  const parsed = paginationInput.safeParse({ page, pageSize });
  if (!parsed.success) throw new ApiError(422, "Choose a valid page and page size", "INVALID_PAGINATION");
  return { ...parsed.data, offset: (page - 1) * pageSize };
}
