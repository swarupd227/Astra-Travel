import { redirect } from 'next/navigation';

/** Policy search lives on the Policies page; older links arrive here. */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const q = (await searchParams).q?.trim();
  redirect(q ? `/policies?q=${encodeURIComponent(q.slice(0, 100))}` : '/policies');
}
