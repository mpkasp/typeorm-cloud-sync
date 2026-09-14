import { DataSource, EntityManager } from 'typeorm/browser';

const transactionChains = new WeakMap<DataSource, Promise<unknown>>();

// sqljs and Capacitor hand every caller the same query runner, so a transaction that starts while
// another is open nests as a SAVEPOINT inside it, and an outer rollback undoes work whose promise has
// already resolved. Runs `work` after every other serialized transaction on the same DataSource.
// A manager that is already inside a transaction runs `work` directly: it holds the lock, and waiting
// on the chain would deadlock.
export function serializeLocalTransaction<T>(manager: EntityManager, work: () => Promise<T>): Promise<T> {
  if (manager.queryRunner?.isTransactionActive) {
    return work();
  }
  const dataSource = manager.connection;
  const run = (transactionChains.get(dataSource) ?? Promise.resolve()).then(work, work);
  transactionChains.set(
    dataSource,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
