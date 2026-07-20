// Resolve the stable storage/wire identity for a StoreRecord (or its class).
//
// Historically this library keyed Firestore collections, Meta collections and
// StoreChangeLog rows on `obj.constructor.name`. That is unsafe under modern
// bundlers (esbuild/Angular) which rename classes (e.g. `User` -> `User2`),
// corrupting collection/table names. Entities now declare an explicit
// `static storeName` string literal (which minifiers do not touch); we fall
// back to `constructor.name` only for classes that have not opted in yet.
export function storeNameOf(target: any): string {
  const ctor = typeof target === 'function' ? target : target?.constructor;
  return ctor?.storeName ?? ctor?.name;
}
