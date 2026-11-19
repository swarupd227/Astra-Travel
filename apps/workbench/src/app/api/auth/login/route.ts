import { NextResponse, type NextRequest } from 'next/server';
import * as client from 'openid-client';
import { oidc, redirectUri } from '@/lib/oidc';
import {
  cookieOptions,
  LOGIN_STATE_COOKIE,
  LOGIN_STATE_MAX_AGE,
  safeReturnTo,
  sealLoginState,
} from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const config = await oidc();
  const codeVerifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(),
    scope: 'openid profile email',
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  const response = NextResponse.redirect(url);
  response.cookies.set(
    LOGIN_STATE_COOKIE,
    await sealLoginState({
      codeVerifier,
      state,
      nonce,
      returnTo: safeReturnTo(request.nextUrl.searchParams.get('returnTo')),
    }),
    cookieOptions(LOGIN_STATE_MAX_AGE),
  );
  return response;
}
