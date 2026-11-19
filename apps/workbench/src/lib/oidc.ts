import * as client from 'openid-client';
import { env } from './env';
import type { Session } from './session';

/**
 * OpenID Connect authorization code flow with PKCE, as a confidential client
 * (Keycloak locally, Microsoft Entra ID in Azure).
 */
let configuration: Promise<client.Configuration> | undefined;

export function oidc(): Promise<client.Configuration> {
  configuration ??= (async () => {
    const e = env();
    const insecure = e.OIDC_ISSUER.startsWith('http://');
    if (insecure && e.NODE_ENV === 'production') {
      throw new Error('OIDC_ISSUER must use https in production');
    }
    return client.discovery(
      new URL(e.OIDC_ISSUER),
      e.WORKBENCH_CLIENT_ID,
      e.WORKBENCH_CLIENT_SECRET,
      undefined,
      insecure ? { execute: [client.allowInsecureRequests] } : undefined,
    );
  })().catch((err: unknown) => {
    configuration = undefined;
    throw err;
  });
  return configuration;
}

export const redirectUri = () => `${env().WORKBENCH_BASE_URL}/api/auth/callback`;

export function sessionFromTokens(
  tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers,
  previous?: Session,
): Session {
  const claims = tokens.claims();
  const expiresIn = tokens.expiresIn() ?? 300;
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    subject: claims?.sub ?? previous?.subject ?? '',
    name:
      (typeof claims?.name === 'string' ? claims.name : null) ??
      (typeof claims?.preferred_username === 'string' ? claims.preferred_username : null) ??
      previous?.name ??
      null,
  };
}

// Concurrent requests that all need a refresh share one token call.
const inflight = new Map<string, Promise<Session>>();

export function refreshSession(session: Session): Promise<Session> {
  const token = session.refreshToken;
  if (!token) return Promise.reject(new Error('No refresh token'));
  let pending = inflight.get(token);
  if (!pending) {
    pending = (async () => {
      const tokens = await client.refreshTokenGrant(await oidc(), token);
      return sessionFromTokens(tokens, session);
    })().finally(() => setTimeout(() => inflight.delete(token), 5_000));
    inflight.set(token, pending);
  }
  return pending;
}
