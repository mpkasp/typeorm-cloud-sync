// Pure Firestore path construction, lifted out of CloudFirebaseFirestore so the client adapter and
// the server (Cloud Function) build identical paths. Parameterized by `getAuthId` because the auth
// id comes from the live user on the client and from the trigger params on the server.
//
// Note: paths are built WITHOUT a leading slash (`User/{uid}/...`). The original private helpers
// produced leading-slash paths that only worked because the web SDK's `doc()`/`collection()`
// normalize them away; the Admin SDK rejects a leading slash (empty first path segment). This form
// is accepted by both SDKs.

export type PathTarget = { storeName: string; isPrivate: boolean };

export class PathBuilder {
  constructor(private getAuthId: () => string | null | undefined) {}

  userPath(authId?: string | null): string {
    const id = authId ?? this.getAuthId();
    if (!id) {
      throw new Error('No cloud user found.');
    }
    return `User/${id}`;
  }

  collectionPath(rec: PathTarget): string {
    return rec.isPrivate ? `${this.userPath()}/${rec.storeName}` : rec.storeName;
  }

  metaCollectionPath(rec: Pick<PathTarget, 'isPrivate'>): string {
    return rec.isPrivate ? `${this.userPath()}/Meta` : 'Meta';
  }

  documentPath(rec: PathTarget & { id: string; authId?: string }): string {
    return rec.storeName === 'User' ? this.userPath(rec.authId) : `${this.collectionPath(rec)}/${rec.id}`;
  }
}
