import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

// Local development shares the repository-root .env with the API and worker. Hosted environments
// set real environment variables and have no such file.
const rootEnv = resolve(import.meta.dirname, '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const isDev = process.env.NODE_ENV !== 'production';

// Sign-out POSTs to this app, which redirects to the identity provider's end-session endpoint.
// CSP form-action also applies to that redirect, so the IdP origin must be allowed.
const idpOrigin = process.env.OIDC_ISSUER ? new URL(process.env.OIDC_ISSUER).origin : '';

// The workbench is a backend-for-frontend: the browser talks only to this app, which calls the API
// server-side with the user's token. Tokens never reach browser JavaScript.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  `form-action 'self' ${idpOrigin}`.trim(),
].join('; ');

// Two places need more than the default: the staff widget preview loads the API's widget script and calls the API from
// the browser, and the hosted journey shows partners' https logos.
const apiOrigin = process.env.API_BASE_URL ? new URL(process.env.API_BASE_URL).origin : '';
const widgetCsp = csp.replace("script-src 'self'", `script-src 'self' ${apiOrigin}`).replace("connect-src 'self'", `connect-src 'self' ${apiOrigin}`).replace("img-src 'self' data:", "img-src 'self' data: https:");
const journeyCsp = csp.replace("img-src 'self' data:", "img-src 'self' data: https:");

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@astra/contracts', '@astra/plans'],
  experimental: {
    // The dev server's own disk cache is written inside the watched project, which can set it recompiling and
    // reloading pages forever, so it is off in development.
    turbopackFileSystemCacheForDev: false,
    // Eligibility feed uploads from the workbench. Server actions buffer the file, so larger feeds go
    // through the API directly (or SFTP in Azure); see docs/integration/eligibility-feed-v1.md.
    serverActions: { bodySizeLimit: '100mb' },
    proxyClientMaxBodySize: '100mb',
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          ...(isDev
            ? []
            : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
        ],
      },
      { source: '/quotes/:quoteId/widget', headers: [{ key: 'Content-Security-Policy', value: widgetCsp }] },
      { source: '/j/:path*', headers: [{ key: 'Content-Security-Policy', value: journeyCsp }] },
    ];
  },
};

export default config;
