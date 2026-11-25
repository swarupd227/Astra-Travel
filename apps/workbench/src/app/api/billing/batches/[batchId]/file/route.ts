import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/api';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/** A batch file, fetched with the signed-in person's own access token so the API decides who may download it. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) return new NextResponse('Not found', { status: 404 });
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL('/api/auth/login', env().WORKBENCH_BASE_URL));
  const upstream = await fetch(new URL(`/v1/billing/batches/${batchId}/file`, env().API_BASE_URL), { headers: { authorization: `Bearer ${session.accessToken}` }, cache: 'no-store' });
  if (!upstream.ok || !upstream.body) return new NextResponse(upstream.status === 404 ? 'Not found' : 'The batch file could not be read', { status: upstream.status === 404 ? 404 : 502 });
  return new NextResponse(upstream.body, { headers: { 'content-type': 'application/x-ndjson', 'content-disposition': upstream.headers.get('content-disposition') ?? 'attachment', 'cache-control': 'private, no-store' } });
}
