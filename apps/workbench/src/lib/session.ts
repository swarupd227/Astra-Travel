import { sealData, unsealData } from 'iron-session';
import { env } from './env';

/**
 * Encrypted, httpOnly session cookies. The access and refresh tokens live in one cookie and the ID
 * token (only needed to end the IdP session at sign-out) in another, to stay under browser cookie
 * size limits. Nothing here is readable by browser JavaScript.
 */
export const SESSION_COOKIE = 'astra_session';
export const ID_TOKEN_COOKIE = 'astra_idt';
export const LOGIN_STATE_COOKIE = 'astra_oidc';

export const SESSION_MAX_AGE_SECONDS = 10 * 60 * 60;
const LOGIN_STATE_MAX_AGE_SECONDS = 10 * 60;

export interface Session {
  accessToken: string;
  refreshToken: string | null;
  /** Access token expiry, epoch seconds. */
  expiresAt: number;
  subject: string;
  name: string | null;
}

export interface LoginState {
  codeVerifier: string;
  state: string;
  nonce: string;
  returnTo: string;
}

export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: env().NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}

const password = () => env().WORKBENCH_SESSION_SECRET;

export async function sealSession(session: Session): Promise<string> {
  return sealData(session, { password: password(), ttl: SESSION_MAX_AGE_SECONDS });
}

export async function unsealSession(value: string | undefined): Promise<Session | null> {
  if (!value) return null;
  try {
    const data = await unsealData<Session>(value, {
      password: password(),
      ttl: SESSION_MAX_AGE_SECONDS,
    });
    return data && typeof data.accessToken === 'string' ? data : null;
  } catch {
    return null;
  }
}

export async function sealIdToken(idToken: string): Promise<string> {
  return sealData({ idToken }, { password: password(), ttl: SESSION_MAX_AGE_SECONDS });
}

export async function unsealIdToken(value: string | undefined): Promise<string | null> {
  if (!value) return null;
  try {
    const data = await unsealData<{ idToken?: string }>(value, {
      password: password(),
      ttl: SESSION_MAX_AGE_SECONDS,
    });
    return data?.idToken ?? null;
  } catch {
    return null;
  }
}

export async function sealLoginState(state: LoginState): Promise<string> {
  return sealData(state, { password: password(), ttl: LOGIN_STATE_MAX_AGE_SECONDS });
}

export async function unsealLoginState(value: string | undefined): Promise<LoginState | null> {
  if (!value) return null;
  try {
    const data = await unsealData<LoginState>(value, {
      password: password(),
      ttl: LOGIN_STATE_MAX_AGE_SECONDS,
    });
    return data && typeof data.codeVerifier === 'string' ? data : null;
  } catch {
    return null;
  }
}

export const LOGIN_STATE_MAX_AGE = LOGIN_STATE_MAX_AGE_SECONDS;

/** Only same-site relative paths are accepted as post-login destinations (no open redirects). */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\'))
    return '/';
  if (value.startsWith('/api/auth')) return '/';
  return value;
}
