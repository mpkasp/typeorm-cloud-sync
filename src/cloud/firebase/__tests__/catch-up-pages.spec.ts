import { catchUpPages } from '../catch-up-pages';

interface FakeDocument {
  changeId: number;
}

const PAGE_SIZE = 500;

// A collection ordered by changeId, paged the way a startAfter query pages it.
const collectionOf = (count: number): FakeDocument[] => Array.from({ length: count }, (_, i) => ({ changeId: i + 1 }));

const fetcherOver = (documents: FakeDocument[]) =>
  jest.fn(async (afterDocument: FakeDocument | undefined) => {
    const start = afterDocument ? documents.indexOf(afterDocument) + 1 : 0;
    return documents.slice(start, start + PAGE_SIZE);
  });

async function collect(fetchPage: (afterDocument: FakeDocument | undefined) => Promise<FakeDocument[]>) {
  const applied: FakeDocument[] = [];
  for await (const page of catchUpPages(fetchPage, PAGE_SIZE)) {
    applied.push(...page);
  }
  return applied;
}

describe('catchUpPages', () => {
  test('501 documents are all applied, and the last one is the listener anchor', async () => {
    const documents = collectionOf(501);
    const fetchPage = fetcherOver(documents);

    const applied = await collect(fetchPage);

    expect(applied).toEqual(documents);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenLastCalledWith(documents[499]);
    expect(applied[applied.length - 1].changeId).toBe(501);
  });

  test('an exactly full last page ends on the empty page after it', async () => {
    const fetchPage = fetcherOver(collectionOf(PAGE_SIZE));
    const pages: FakeDocument[][] = [];
    for await (const page of catchUpPages(fetchPage, PAGE_SIZE)) {
      pages.push(page);
    }

    expect(pages.map((page) => page.length)).toEqual([PAGE_SIZE]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  test('an empty collection yields nothing', async () => {
    const fetchPage = fetcherOver([]);
    expect(await collect(fetchPage)).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  test('the next page is fetched before the current one is yielded', async () => {
    const fetchPage = fetcherOver(collectionOf(501));
    const callsWhenFirstPageYielded: number[] = [];
    for await (const _page of catchUpPages(fetchPage, PAGE_SIZE)) {
      callsWhenFirstPageYielded.push(fetchPage.mock.calls.length);
    }
    expect(callsWhenFirstPageYielded).toEqual([2, 2]);
  });

  test('a failed page fetch reaches the consumer after the pages before it', async () => {
    const documents = collectionOf(501);
    const fetchPage = jest.fn(async (afterDocument: FakeDocument | undefined) => {
      if (afterDocument) {
        throw new Error('unavailable');
      }
      return documents.slice(0, PAGE_SIZE);
    });
    const applied: FakeDocument[] = [];

    await expect(
      (async () => {
        for await (const page of catchUpPages(fetchPage, PAGE_SIZE)) {
          applied.push(...page);
        }
      })(),
    ).rejects.toThrow('unavailable');
    expect(applied).toHaveLength(PAGE_SIZE);
  });
});
