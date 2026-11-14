import { createRemoteJWKSet, importSPKI, jwtVerify } from "jose";
import { ApiError } from "../context";

export interface PrivyLinkedAccount {type:string;address?:string;email?:string;name?:string;first_verified_at?:number;chain_type?:string;wallet_client_type?:string;connector_type?:string;imported?:boolean;delegated?:boolean;user_can_sign?:boolean;id?:string}

export async function verifyPrivy(accessToken: string, requireProfile = false) {
  const appId = process.env.PRIVY_APP_ID || process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) throw new ApiError(503, "Configure Privy application credentials to enable Google and email sign-in", "SOCIAL_LOGIN_SETUP_REQUIRED");
  let key;
  if (process.env.PRIVY_VERIFICATION_KEY) {
    key = await importSPKI(process.env.PRIVY_VERIFICATION_KEY.replace(/\\n/g, "\n"), "ES256");
  } else if (process.env.PRIVY_JWKS_URL) {
    const url = new URL(process.env.PRIVY_JWKS_URL);
    if (url.protocol !== "https:" && !(process.env.NODE_ENV === "test" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new ApiError(503, "Privy verification keys require an HTTPS endpoint", "SOCIAL_LOGIN_SETUP_REQUIRED");
    key = createRemoteJWKSet(url);
  } else {
    throw new ApiError(503, "Configure PRIVY_VERIFICATION_KEY or PRIVY_JWKS_URL to verify social sign-in", "SOCIAL_LOGIN_SETUP_REQUIRED");
  }
  const { payload } = await jwtVerify(accessToken, key, { issuer: "privy.io", audience: appId, algorithms: ["ES256"], requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5 });
  if (!payload.sub?.startsWith("did:privy:")) throw new ApiError(401, "Invalid sign-in identity", "INVALID_IDENTITY");
  if(typeof payload.iat!=="number"||Date.now()/1000-payload.iat>900||payload.iat>Date.now()/1000+60)throw new ApiError(401,"Sign out of Google or email in the provider and sign in again to verify a recent session.","FRESH_PROVIDER_LOGIN_REQUIRED");
  if (requireProfile && !process.env.PRIVY_APP_SECRET) throw new ApiError(503, "Configure the Privy server profile credential before setting up an embedded NEAR signer", "EMBEDDED_NEAR_SETUP_REQUIRED");
  let linkedAccounts: PrivyLinkedAccount[] = [];
  let email: string | null = null;
  let name = "Company owner";
  if (process.env.PRIVY_APP_SECRET) {
    const response = await fetch(`https://api.privy.io/v1/users/${encodeURIComponent(payload.sub)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${appId}:${process.env.PRIVY_APP_SECRET}`).toString("base64")}`, "privy-app-id": appId },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new ApiError(502, "Could not verify the social profile. Please try again.", "IDENTITY_PROVIDER_UNAVAILABLE");
    const profile = await response.json() as { id?: string; linked_accounts?: PrivyLinkedAccount[] };
    if (profile.id !== payload.sub) throw new ApiError(401, "Profile identity did not match sign-in", "INVALID_IDENTITY");
    linkedAccounts = profile.linked_accounts || [];
    const identity = profile.linked_accounts?.find((account) => account.type === "email" && account.address) || profile.linked_accounts?.find((account) => account.type === "google_oauth" && account.email);
    email = (identity?.address || identity?.email || "").toLowerCase() || null;
    name = identity?.name || email?.split("@")[0] || name;
  }
  return { subject: payload.sub, email, name, linkedAccounts };
}

