/**
 * Load every row of an offset-paged list endpoint (`{ data, total }`), so the
 * counts, groups and filters built on the result cover everyone instead of
 * silently stopping at one page (PRO-96).
 *
 * The first page reports the server's `total`; the remaining pages are then
 * requested in parallel. `maxRows` is a safety ceiling for very large
 * universes — callers that set one must show "Showing X of Y" whenever
 * `data.length < total`, because the returned `total` is always the server's.
 */
export type Page<T> = { data: T[]; total: number };

export async function fetchAllPages<T>(
  fetchPage: (limit: number, offset: number) => Promise<Page<T>>,
  pageSize: number,
  maxRows: number = Infinity,
): Promise<Page<T>> {
  const firstLimit = Math.min(pageSize, maxRows);
  const first = await fetchPage(firstLimit, 0);
  const total = first.total;
  const want = Math.min(total, maxRows);
  if (first.data.length >= want || first.data.length < firstLimit) return { data: first.data.slice(0, want), total };

  const offsets: number[] = [];
  for (let off = first.data.length; off < want; off += pageSize) offsets.push(off);
  const rest = await Promise.all(offsets.map((off) => fetchPage(Math.min(pageSize, want - off), off)));
  return { data: [...first.data, ...rest.flatMap((p) => p.data)], total };
}
