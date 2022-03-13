# TypeOrm Cloud Sync
To install this locally, run `npm pack` to create a local tgz. Then install the tgz `npm install [tgz]`

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
import { BaseUserSubscriber } from 'typeorm-cloud-sync';
import { StoreChangeLogSubscriber } from 'typeorm-cloud-sync';

...

connection.subscribers.push(new StoreChangeLogSubscriber(this.cloudStore));
connection.subscribers.push(new UserSubscriber(this.cloudStore));
```
