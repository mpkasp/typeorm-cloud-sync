import { SqliteStore } from './sqlite-store';
import { CloudStore } from './cloud/cloud-store';

// One account's complete, isolated stack: its own DataSource (held by the SqliteStore) and its own
// CloudStore. Isolation is structural rather than a matter of query discipline — a query on one
// tenant's DataSource cannot return another tenant's rows — so running N accounts concurrently is
// a matter of holding N of these.
export class Tenant {
  constructor(
    public readonly authId: string,
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
export type TenantOpener = (authId: string) => Promise<Tenant>;

export class TenantRegistry {
  private readonly tenants = new Map<string, Tenant>();
  private readonly opening = new Map<string, Promise<Tenant>>();

  constructor(private readonly openTenant: TenantOpener) {}

  // Idempotent: concurrent opens of the same account share one Tenant, so an account can never end
  // up with two DataSources over the same database.
  async open(authId: string): Promise<Tenant> {
    const existing = this.tenants.get(authId);
    if (existing) {
      return existing;
    }
    const pending = this.opening.get(authId);
    if (pending) {
      return pending;
    }
    const creating = this.openTenant(authId)
      .then((tenant) => {
        this.tenants.set(authId, tenant);
        return tenant;
      })
      .finally(() => this.opening.delete(authId));
    this.opening.set(authId, creating);
    return creating;
  }

  get(authId: string): Tenant | undefined {
    return this.tenants.get(authId);
  }

  has(authId: string): boolean {
    return this.tenants.has(authId);
  }

  list(): Tenant[] {
    return [...this.tenants.values()];
  }

  async close(authId: string): Promise<void> {
    const tenant = this.tenants.get(authId);
    if (!tenant) {
      return;
    }
    this.tenants.delete(authId);
    await tenant.dispose();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.tenants.keys()].map((authId) => this.close(authId)));
  }
}
