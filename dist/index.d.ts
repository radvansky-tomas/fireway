import * as admin from 'firebase-admin';
export interface MigrateOptions {
    app: admin.app.App;
    auth: admin.auth.Auth;
    storage: admin.storage.Storage;
    firestore: admin.firestore.Firestore;
    FieldValue: typeof admin.firestore.FieldValue;
    FieldPath: typeof admin.firestore.FieldPath;
    Timestamp: typeof admin.firestore.Timestamp;
    dryrun: boolean;
}
export interface MigrationStats {
    scannedFiles: number;
    executedFiles: number;
    created: number;
    set: number;
    updated: number;
    deleted: number;
    added: number;
    frozen?: boolean;
}
interface MigrateParams {
    path?: string;
    projectId?: string;
    storageBucket?: string;
    dryrun?: boolean;
    app?: admin.app.App;
    debug?: boolean;
    require?: string;
    forceWait?: boolean;
    databaseId?: string;
}
export declare function migrate(params?: MigrateParams): Promise<MigrationStats>;
export {};
