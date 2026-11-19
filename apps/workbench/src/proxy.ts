import { NextResponse, type NextRequest } from 'next/server';
import { refreshSession } from '@/lib/oidc';
import {
  cookieOptions,
  ID_TOKEN_COOKIE,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  sealSession,
  unsealSession,
} from '@/lib/session';

const REFRESH_WITHIN_SECONDS = 60;

/**
 * Runs before every workbench page and server action: sends unauthenticated users to sign in, and
 * refreshes access tokens shortly before they expire. If the IdP refuses the refresh (for example
 * because the user was disabled), the session ends.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const session = await unsealSession(request.cookies.get(SESSION_COOKIE)?.value);
  const loginUrl = new URL(
    `/api/auth/login?returnTo=${encodeURIComponent(pathname + search)}`,
    request.url,
  );

  if (!session) return NextResponse.redirect(loginUrl);

  const now = Math.floor(Date.now() / 1000);
  if (session.expiresAt - now > REFRESH_WITHIN_SECONDS) return NextResponse.next();

  try {
    const refreshed = await refreshSession(session);
    const sealed = await sealSession(refreshed);
    request.cookies.set(SESSION_COOKIE, sealed);
    const response = NextResponse.next({ request: { headers: request.headers } });
    response.cookies.set(SESSION_COOKIE, sealed, cookieOptions(SESSION_MAX_AGE_SECONDS));
    return response;
  } catch {
    const response = NextResponse.redirect(loginUrl);
    response.cookies.delete(SESSION_COOKIE);
    response.cookies.delete(ID_TOKEN_COOKIE);
    return response;
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|api/auth|signed-out).*)'],
};
