export interface AccessContext {
  userId: string;
  organizationId: string;
  permissions: string[];
}

export type AppEnv = {
  Variables: {
    userId: string;
    access: AccessContext;
  };
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = "REQUEST_FAILED") {
    super(message);
  }
}

export function requirePermission(access: AccessContext, permission: string): void {
  if (!access.permissions.includes(permission)) throw new ApiError(403, "You do not have permission for this action", "FORBIDDEN");
}
