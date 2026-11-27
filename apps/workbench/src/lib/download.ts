import { NextResponse } from 'next/server';
import { getSession } from './api';
import { env } from './env';

/** Passes a file from the API to the browser using the signed-in person's own access token. */
export async function downloadFromApi(
  path: string,
  query: Record<string, string> = {},
): Promise<NextResponse> {
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL('/api/auth/login', env().WORKBENCH_BASE_URL));
  const url = new URL(path, env().API_BASE_URL);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const upstream = await fetch(url, {
    headers: { authorization: `Bearer ${session.accessToken}` },
    cache: 'no-store',
  });
  if (!upstream.ok || !upstream.body) {
    const status = [400, 403, 404].includes(upstream.status) ? upstream.status : 502;
    return new NextResponse(
      status === 404
        ? 'Not found'
        : status === 403
          ? 'You are not allowed to download this'
          : status === 400
            ? 'Check the dates and try again'
            : 'The file could not be read',
      { status },
    );
  }
  return new NextResponse(upstream.body, {
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'content-disposition': upstream.headers.get('content-disposition') ?? 'attachment',
      'cache-control': 'private, no-store',
    },
  });
}
