import { NextResponse, type NextRequest } from 'next/server';
import type { IssuedDocument } from '@astra/contracts';
import { journeyApi, journeyConfig } from '@/lib/journey';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Files for the hosted journey: the filed policy wording of a quote (`wording?quote=`) and a policy's documents
 * (`<documentId>?policy=`). A document is served only if it is one of that policy's, so a guessed document ID of
 * another policy gets nothing.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string; documentId: string }> }) {
  const { slug, documentId } = await params;
  const cfg = await journeyConfig(slug);
  if (!cfg) return new NextResponse('Not found', { status: 404 });
  const q = request.nextUrl.searchParams;
  try {
    let path: string;
    if (documentId === 'wording') {
      const quote = q.get('quote') ?? '';
      if (!UUID.test(quote)) return new NextResponse('Not found', { status: 404 });
      path = `/v1/quotes/${quote}/wording`;
    } else {
      const policy = q.get('policy') ?? '';
      if (!UUID.test(documentId) || !UUID.test(policy)) return new NextResponse('Not found', { status: 404 });
      const docs = await journeyApi<{ items: IssuedDocument[] }>(cfg, `/v1/policies/${policy}/documents`);
      if (!docs.items.some((d) => d.id === documentId && d.status === 'issued')) return new NextResponse('Not found', { status: 404 });
      path = `/v1/documents/${documentId}/file`;
    }
    const upstream = await journeyApi<Response>(cfg, path, { raw: true });
    return new NextResponse(upstream.body, { headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream', 'content-disposition': upstream.headers.get('content-disposition') ?? 'inline', 'cache-control': 'private, no-store' } });
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
}
