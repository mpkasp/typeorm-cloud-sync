import { PathBuilder } from '../path-builder';

const AUTH = 'uid-1';

describe('PathBuilder', () => {
  const paths = new PathBuilder(() => AUTH);

  it('builds private paths under the user document, without a leading slash', () => {
    expect(paths.userDocument()).toBe(`User/${AUTH}`);
    expect(paths.collectionPath({ storeName: 'MedicineLog', isPrivate: true })).toBe(`User/${AUTH}/MedicineLog`);
    expect(paths.metaCollectionPath({ storeName: 'MedicineLog', isPrivate: true })).toBe(`User/${AUTH}/Meta`);
    expect(paths.documentPath({ storeName: 'MedicineLog', isPrivate: true, id: 'e1' })).toBe(
      `User/${AUTH}/MedicineLog/e1`,
    );
  });

  it('builds public paths at the top level', () => {
    expect(paths.collectionPath({ storeName: 'Announcement', isPrivate: false })).toBe('Announcement');
    expect(paths.metaCollectionPath({ storeName: 'Announcement', isPrivate: false })).toBe('Meta');
  });

  it('keys the User document by auth id', () => {
    expect(paths.documentPath({ storeName: 'User', isPrivate: true, id: 'ignored', authId: 'other-uid' })).toBe(
      'User/other-uid',
    );
  });

  it('throws when no auth id is available for a private path', () => {
    const anon = new PathBuilder(() => null);
    expect(() => anon.collectionPath({ storeName: 'MedicineLog', isPrivate: true })).toThrow('No cloud user found.');
  });
});
