// Yields a collection's backlog one page at a time, where `fetchPage(afterDocument)` returns up to
// `pageSize` documents after `afterDocument` (from the start when undefined). A page shorter than
// `pageSize` is the last one. The next page is fetched before the current one is yielded, so its
// round trip overlaps the consumer's local write; pages are still yielded strictly in order.
export async function* catchUpPages<Document>(
  fetchPage: (afterDocument: Document | undefined) => Promise<Document[]>,
  pageSize: number,
): AsyncGenerator<Document[]> {
  let page = await fetchPage(undefined);
  while (page.length > 0) {
    const nextPage = page.length === pageSize ? fetchPage(page[page.length - 1]) : null;
    // A consumer that stops early never awaits nextPage; this marks its rejection observed. The
    // value or error still reaches the await below when iteration continues.
    nextPage?.catch(() => undefined);
    yield page;
    if (!nextPage) {
      return;
    }
    page = await nextPage;
  }
}
