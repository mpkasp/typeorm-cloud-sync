// Local-first opening depends on an otherwise implicit property: `new CloudFirebaseFirestore(...)`
// is inert — it touches no Firestore handle, opens no listener, and reaches no network. Only
// initialize() does. That is what lets a Tenant hold an unconnected cloud and attach it later, fully
// usable offline in between. These tests pin the contract that matters — construction performs no
// I/O — so a future network touch slipped into the constructor is caught here rather than in a
// consumer's offline path.

const firestore = {
  __esModule: true,
  getFirestore: jest.fn(),
  collection: jest.fn(),
  doc: jest.fn(),
  addDoc: jest.fn(),
  setDoc: jest.fn(),
  getDocs: jest.fn(),
  deleteDoc: jest.fn(),
  onSnapshot: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  limit: jest.fn(),
  orderBy: jest.fn(),
  startAfter: jest.fn(),
};
const app = {
  __esModule: true,
  initializeApp: jest.fn(),
};

jest.mock('firebase/firestore', () => firestore);
jest.mock('firebase/app', () => app);

import { BehaviorSubject } from 'rxjs';
import { CloudFirebaseFirestore } from '../cloud-firebase-firestore';
import { BaseUser } from '../../../models/base-user.model';
import { Note, Tag } from '../../../__tests__/fake-entities';

const firebaseMocks = (): jest.Mock[] =>
  [...Object.values(firestore), ...Object.values(app)].filter((value) => typeof value === 'function') as jest.Mock[];

describe('CloudFirebaseFirestore construction', () => {
  beforeEach(() => firebaseMocks().forEach((mock) => mock.mockClear()));

  it('touches no Firestore handle, listener, or network when constructed', () => {
    new CloudFirebaseFirestore(BaseUser, [Note], [Tag], new BehaviorSubject<boolean>(true));

    firebaseMocks().forEach((mock) => expect(mock).not.toHaveBeenCalled());
  });

  it('wires up the observables immediately, before any cloud is attached', () => {
    const store = new CloudFirebaseFirestore(BaseUser, [Note], [Tag], new BehaviorSubject<boolean>(true));

    expect(store.user).toBeNull();
    expect(store.downloading).toBe(false);
    let online: boolean | undefined;
    store.network$.subscribe((value) => (online = value));
    expect(online).toBe(true);
  });
});
