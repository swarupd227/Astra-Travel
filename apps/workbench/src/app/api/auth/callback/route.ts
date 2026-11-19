import { NextResponse, type NextRequest } from 'next/server';
import * as client from 'openid-client';
import { env } from '@/lib/env';
import { oidc, sessionFromTokens } from '@/lib/oidc';
import {
  cookieOptions,
  ID_TOKEN_COOKIE,
  LOGIN_STATE_COOKIE,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  sealIdToken,
  sealSession,
  unsealLoginState,
} from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const base = env().WORKBENCH_BASE_URL;
  const login = await unsealLoginState(request.cookies.get(LOGIN_STATE_COOKIE)?.value);
  if (!login) {
    return NextResponse.redirect(new URL('/signed-out?reason=expired', base));
  }
  // Rebuild the callback URL from the public base URL (the app may run behind a proxy).
  const callbackUrl = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, base);

  try {
    const tokens = await client.authorizationCodeGrant(await oidc(), callbackUrl, {
      pkceCodeVerifier: login.codeVerifier,
      expectedState: login.state,
      expectedNonce: login.nonce,
      idTokenExpected: true,
    });
    const response = NextResponse.redirect(new URL(login.returnTo, base));
    response.cookies.set(
      SESSION_COOKIE,
      await sealSession(sessionFromTokens(tokens)),
      cookieOptions(SESSION_MAX_AGE_SECONDS),
    );
    if (tokens.id_token) {
      response.cookies.set(
        ID_TOKEN_COOKIE,
        await sealIdToken(tokens.id_token),
        cookieOptions(SESSION_MAX_AGE_SECONDS),
      );
    }
    response.cookies.delete(LOGIN_STATE_COOKIE);
    return response;
  } catch (err) {
    console.error('Sign-in callback failed', err instanceof Error ? err.message : err);
    const response = NextResponse.redirect(new URL('/signed-out?reason=failed', base));
    response.cookies.delete(LOGIN_STATE_COOKIE);
    return response;
  }
}
