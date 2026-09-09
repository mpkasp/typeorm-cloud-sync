// subscribeCloudUser() gates initialize(), which gates privateCloudInitialized, which gates the
// change-log drain. So a subscribeCloudUser() that never settles does not merely skip a download — it
// stops the store uploading anything at all. These tests pin the contract that matters — it always
// settles — across every way the snapshot can turn out, including the empty snapshot a brand-new
// account (no /User document yet) receives.

const onSnapshotMock = jest.fn();

jest.mock('firebase/firestore', () => ({
  __esModule: true,
  doc: jest.fn(() => ({path: 'User/managed-uid'})),
  onSnapshot: (...args: unknown[]) => onSnapshotMock(...args),
  collection: jest.fn(),
  addDoc: jest.fn(),
  setDoc: jest.fn(),
  getDocs: jest.fn(),
  deleteDoc: jest.fn(),
  getFirestore: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  writeBatch: jest.fn(),
  runTransaction: jest.fn(),
  serverTimestamp: jest.fn(),
  enableIndexedDbPersistence: jest.fn(),
  initializeFirestore: jest.fn(),
}));

import { CloudFirebaseFirestore } from '../cloud/firebase/cloud-firebase-firestore';
import { BaseUser } from '../models/base-user.model';

type SnapshotHandler = (snapshot: unknown) => unknown;
type ErrorHandler = (error: unknown) => unknown;

/** A store with just enough wired up to drive subscribeCloudUser directly. */
function makeStore(): CloudFirebaseFirestore {
  const store = new CloudFirebaseFirestore(BaseUser, [], []);
  const user = new BaseUser({authId: 'managed-uid'});
  // The subscription is keyed off the local user's authId.
  (store as any).userSubject.next(user);
  (store as any).db = {};
  return store;
}

const subscribeCloudUser = (store: CloudFirebaseFirestore): Promise<void> =>
  (store as any).subscribeCloudUser();

/** Hand back the callbacks onSnapshot was registered with. */
function capturedHandlers(): {next: SnapshotHandler; error: ErrorHandler} {
  expect(onSnapshotMock).toHaveBeenCalled();
  const [, next, error] = onSnapshotMock.mock.calls[0];
  return {next: next as SnapshotHandler, error: error as ErrorHandler};
}

describe('CloudFirebaseFirestore.subscribeCloudUser()', () => {
  beforeEach(() => onSnapshotMock.mockReset());

  it('settles when the account has no cloud user document yet', async () => {
    const store = makeStore();
    const pending = subscribeCloudUser(store);

    // Firestore delivers a snapshot for a document that does not exist; data() is undefined.
    capturedHandlers().next({exists: () => false, data: () => undefined, id: 'managed-uid'});

    await expect(pending).resolves.toBeUndefined();
  });

  it('settles even when applying the snapshot throws', async () => {
    const store = makeStore();
    // Force the merge to fail the way a malformed document would.
    (store as any).deserialize = () => {
      throw new Error('bad document');
    };
    const pending = subscribeCloudUser(store);

    capturedHandlers().next({exists: () => true, data: () => ({}), id: 'managed-uid'});

    await expect(pending).resolves.toBeUndefined();
  });

  it('settles when the subscription itself fails', async () => {
    const store = makeStore();
    const pending = subscribeCloudUser(store);

    // e.g. the security rules reject the listener.
    capturedHandlers().error(new Error('permission-denied'));

    await expect(pending).resolves.toBeUndefined();
  });

  it('returns without subscribing when there is no local user to subscribe for', async () => {
    const store = new CloudFirebaseFirestore(BaseUser, [], []);
    (store as any).db = {};

    await expect(subscribeCloudUser(store)).resolves.toBeUndefined();
    expect(onSnapshotMock).not.toHaveBeenCalled();
  });
});
