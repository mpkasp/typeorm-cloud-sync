import { SqliteStore } from './sqlite-store';
import { CloudStore } from './cloud/cloud-store';

// One account's complete, isolated stack: its own DataSource (held by the SqliteStore) and its own
// CloudStore. Isolation is structural rather than a matter of query discipline — a query on one
// tenant's DataSource cannot return another tenant's rows — so running N accounts concurrently is
// a matter of holding N of these.
export class Tenant {
  constructor(
    // The local identity a consumer keys this account on. It is NOT the Firebase authId: an account
    // can exist and be usable locally before a cloud account is minted for it, so a caretaker app
    // keys managed accounts on a locally generated id (e.g. a grant UUID) that is available offline.
    // The Firebase authId lives on the cloud store — see CloudStore.user.authId, read through
    // PathBuilder.getAuthId() — and may differ from, or arrive after, this key.
    public readonly key: string,
    public readonly localStore: SqliteStore,
    public readonly cloud: CloudStore,
  ) {}

  // Stop the cloud first so no new work starts, then let any in-flight drain finish before the
  // database goes away underneath it.
  async dispose(): Promise<void> {
    this.cloud.dispose();
    await this.cloud.whenIdle();
    await this.localStore.dataSource.destroy();
  }
}

// Supplied by the app, which owns the pieces the library cannot build for it: the DataSource
// (driver, entities, migrations) and the cloud binding (a FirebaseApp / FirestorePort per account).
// `key` is the local account key (see Tenant.key), not the Firebase authId.
export type TenantOpener = (key: string) => Promise<Tenant>;

export class TenantRegistry {
  private readonly tenants = new Map<string, Tenant>();
  private readonly opening = new Map<string, Promise<Tenant>>();

  constructor(private readonly openTenant: TenantOpener) {}

  // Idempotent: concurrent opens of the same account share one Tenant, so an account can never end
  // up with two DataSources over the same database.
  async open(key: string): Promise<Tenant> {
    const existing = this.tenants.get(key);
    if (existing) {
      return existing;
    }
    const pending = this.opening.get(key);
    if (pending) {
      return pending;
    }
    const creating = this.openTenant(key)
      .then((tenant) => {
        this.tenants.set(key, tenant);
        return tenant;
      })
      .finally(() => this.opening.delete(key));
    this.opening.set(key, creating);
    return creating;
  }

  get(key: string): Tenant | undefined {
    return this.tenants.get(key);
  }

  has(key: string): boolean {
    return this.tenants.has(key);
  }

  list(): Tenant[] {
    return [...this.tenants.values()];
  }

  async close(key: string): Promise<void> {
    const tenant = this.tenants.get(key);
    if (!tenant) {
      return;
    }
    this.tenants.delete(key);
    await tenant.dispose();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.tenants.keys()].map((key) => this.close(key)));
  }
}
