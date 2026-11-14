import { ApiError } from "../context";
import { row } from "../db";
export function isSupportOperator(userId: string) {
  return (
    (process.env.RAZOR_SUPPORT_OPERATOR_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .includes(userId) && !!row("SELECT id FROM users WHERE id=?", userId)
  );
}
export function requireSupportOperator(userId: string) {
  if (!isSupportOperator(userId))
    throw new ApiError(
      403,
      "This existing user is not an explicitly allowlisted support operator",
      "SUPPORT_OPERATOR_REQUIRED",
    );
  return userId;
}
