import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/api';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/** A document's PDF, fetched with the signed-in person's own access token so the API decides who may see it. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) return new NextResponse('Not found', { status: 404 });
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL('/api/auth/login', env().WORKBENCH_BASE_URL));
  const upstream = await fetch(new URL(`/v1/documents/${documentId}/file`, env().API_BASE_URL), {
    headers: { authorization: `Bearer ${session.accessToken}`, accept: 'application/pdf' },
    cache: 'no-store',
  });
  if (!upstream.ok || !upstream.body)
    return new NextResponse(
      upstream.status === 404 ? 'Not found' : 'The document could not be read',
      { status: upstream.status === 404 ? 404 : 502 },
    );
  return new NextResponse(upstream.body, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': upstream.headers.get('content-disposition') ?? 'inline',
      'cache-control': 'private, no-store',
    },
  });
}
