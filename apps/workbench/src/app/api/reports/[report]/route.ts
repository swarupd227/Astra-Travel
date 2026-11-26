import { NextResponse, type NextRequest } from 'next/server';
import { downloadFromApi } from '@/lib/download';

export const dynamic = 'force-dynamic';

/** A report as a CSV file. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  if (report !== 'accounts' && report !== 'statutory') return new NextResponse('Not found', { status: 404 });
  const query: Record<string, string> = {};
  for (const key of ['from', 'to', 'accountId']) {
    const v = request.nextUrl.searchParams.get(key);
    if (v) query[key] = v;
  }
  return downloadFromApi(`/v1/reports/${report}.csv`, query);
}
