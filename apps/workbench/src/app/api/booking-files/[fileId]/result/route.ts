import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/api';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/** A booking file's result, fetched with the signed-in person's own access token. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) return new NextResponse('Not found', { status: 404 });
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL('/api/auth/login', env().WORKBENCH_BASE_URL));
  const upstream = await fetch(new URL(`/v1/booking-files/${fileId}/result`, env().API_BASE_URL), { headers: { authorization: `Bearer ${session.accessToken}` }, cache: 'no-store' });
  if (!upstream.ok || !upstream.body) return new NextResponse(upstream.status === 404 ? 'Not found' : 'The result could not be read', { status: upstream.status === 404 ? 404 : 502 });
  return new NextResponse(upstream.body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': upstream.headers.get('content-disposition') ?? 'attachment', 'cache-control': 'private, no-store' } });
}
