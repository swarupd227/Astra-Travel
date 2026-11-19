import { NextResponse, type NextRequest } from 'next/server';
import * as client from 'openid-client';
import { env } from '@/lib/env';
import { oidc } from '@/lib/oidc';
import { ID_TOKEN_COOKIE, LOGIN_STATE_COOKIE, SESSION_COOKIE, unsealIdToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Sign-out is a POST (from a form) so it cannot be triggered by a link or image on another site. */
export async function POST(request: NextRequest) {
  const base = env().WORKBENCH_BASE_URL;
  const idToken = await unsealIdToken(request.cookies.get(ID_TOKEN_COOKIE)?.value);
  let target = new URL('/signed-out', base);
  try {
    target = client.buildEndSessionUrl(await oidc(), {
      post_logout_redirect_uri: `${base}/signed-out`,
      ...(idToken ? { id_token_hint: idToken } : { client_id: env().WORKBENCH_CLIENT_ID }),
    });
  } catch {
    // The IdP is unreachable: still clear the local session.
  }
  const response = NextResponse.redirect(target, 303);
  for (const name of [SESSION_COOKIE, ID_TOKEN_COOKIE, LOGIN_STATE_COOKIE])
    response.cookies.delete(name);
  return response;
}
