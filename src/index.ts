export const Greeter = (name: string) => `Hello ${name}`;

export {SqliteStore} from "./sqlite-store";
export {CloudFirebaseFirestore} from "./cloud/firebase/cloud-firebase-firestore"
export {CloudStore} from "./cloud/cloud-store";
export {StoreRecord} from "./models/store-record.model"
export {StoreChangeLog} from "./models/store-change-log.model"
