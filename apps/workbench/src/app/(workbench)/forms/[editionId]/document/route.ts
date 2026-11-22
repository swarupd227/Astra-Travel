import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/api';
import { env } from '@/lib/env';

/** Streams the filed document from the API with the signed-in user's token (the browser never sees it). */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ editionId: string }> },
) {
  const { editionId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(editionId)) return new NextResponse('Not found', { status: 404 });
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL('/api/auth/login', request.url));
  const res = await fetch(new URL(`/v1/form-editions/${editionId}/document`, env().API_BASE_URL), {
    headers: { authorization: `Bearer ${session.accessToken}`, 'x-correlation-id': randomUUID() },
    cache: 'no-store',
  });
  if (!res.ok || !res.body) {
    return new NextResponse(
      res.status === 404 ? 'Not found' : 'The document could not be loaded.',
      { status: res.status === 404 ? 404 : 502 },
    );
  }
  const headers = new Headers();
  for (const h of ['content-type', 'content-disposition', 'x-content-sha256']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('cache-control', 'private, no-store');
  return new NextResponse(res.body, { status: 200, headers });
}
