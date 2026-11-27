import { NextResponse, type NextRequest } from 'next/server';
import { downloadFromApi } from '@/lib/download';

export const dynamic = 'force-dynamic';

/** The audit trace of a premium record or a document, as a JSON file. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  const { kind, id } = await params;
  if ((kind !== 'premium-records' && kind !== 'documents') || !/^[0-9a-f-]{36}$/i.test(id))
    return new NextResponse('Not found', { status: 404 });
  return downloadFromApi(`/v1/trace/${kind}/${id}`, { download: 'true' });
}
