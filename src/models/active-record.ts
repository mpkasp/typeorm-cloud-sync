import { EntityManager } from 'typeorm/browser';

// The EntityManager an ActiveRecord call resolves to: the DataSource that DataSource.initialize()
// last bound to the entity class. Only one DataSource can hold that binding at a time, so the
// library's own read/write path never relies on it — internal calls take an explicit EntityManager.
// This backs the ActiveRecord methods (record.save() and friends) that callers still invoke directly.
export function activeRecordManager(target: Function): EntityManager {
  return (target as any).getRepository().manager;
}
