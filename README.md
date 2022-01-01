# TypeOrm Cloud Sync

Usage:

1. Set up your typeorm connection, then pass your connection to set up sqlite store:
```typescript
this.sqliteStore = new SqliteStore(connection);
```

Optionally pass a custom user model.
2. Optionally, set up cloud with the sqlite store:
```typescript
const publicRecords: StoreRecord[] = [...PublicRecord1...];
const privateRecords: StoreRecord[] = [...PrivateRecord1...];
const firebaseApp: FirebaseApp = app;
this.cloudStore = new CloudFirebaseFirestore(
  this.sqliteStore, 
  MyUserModel,
  publicRecords,
  privateRecords,
  firebaseApp
);
```

If setting up private cloud, you must add a subscriber to typeorm's subscribers after the connection is created such that we can inject some objects:

```typescript
import { UserSubscriber } from '@typeorm-cloud-sync/user.subscriber';

...

connection.subscribers.push(new UserSubscriber(this.cloudStore));
```
