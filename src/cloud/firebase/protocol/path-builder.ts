// The Firestore path helpers, moved verbatim out of CloudFirebaseFirestore so the client (web SDK)
// and a Cloud Function (Admin SDK) build identical paths. Changes vs the originals are only:
//   - they take a minimal { storeName, isPrivate, id?, authId? } instead of a StoreRecord, so
//     storeNameOf(obj) is already resolved to obj.storeName by the caller;
//   - the auth id comes from an injected getAuthId() instead of this.user?.authId;
//   - userDocument returns `User/{uid}` WITHOUT the original leading slash. The old value
//     `/User/{uid}` only worked because the web SDK's doc()/collection() normalize a leading slash
//     away; the Admin SDK rejects it (empty first path segment). Both SDKs accept the un-prefixed
//     form, and it is the same collection either way. This also lets metaCollectionPath drop the
//     `doc(this.db, this.userDocument()).path + '/Meta'` hack for a plain template (same result).

export type PathTarget = { storeName: string; isPrivate: boolean; id?: string; authId?: string };

export class PathBuilder {
  constructor(private getAuthId: () => string | null | undefined) {}

  public collectionPath(obj: PathTarget): string {
    if (!obj.isPrivate) {
      return `${obj.storeName}`;
    }
    return `${this.userDocument()}/${obj.storeName}`;
  }

  public metaCollectionPath(obj: PathTarget): string {
    if (!obj.isPrivate) {
      return `Meta`;
    }
    return `${this.userDocument()}/Meta`;
  }

  public documentPath(obj: PathTarget): string {
    return obj.storeName === 'User' ? this.userDocument(obj.authId) : `${this.collectionPath(obj)}/${obj.id}`;
  }

  // User for private data
  public userDocument(authId?: string | null): string {
    // console.log('[userDocument] ', this.getAuthId());
    if (!authId) {
      authId = this.getAuthId();
    }
    if (authId) {
      return `User/${authId}`;
    }
    throw new Error('No cloud user found.');
  }
}
