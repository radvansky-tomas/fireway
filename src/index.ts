import path from 'node:path';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import fs from 'node:fs/promises';
import asyncHooks from 'node:async_hooks';
import md5 from 'md5';
import * as admin from 'firebase-admin';
import semver from 'semver';

export interface MigrateOptions {
  app: admin.app.App;
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

interface MigrationModule {
  migrate: (options: MigrateOptions) => Promise<unknown> | unknown;
}

interface MigrationFile {
  filename: string;
  path: string;
  version: string;
  description: string;
}

interface MigrationRecord {
  installed_rank: number;
  version: string;
  script: string;
  success: boolean;
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

type DebugLogger = (...args: ReadonlyArray<unknown>) => void;

interface FirestoreWithStats extends admin.firestore.Firestore {
  _fireway_stats?: MigrationStats;
}

interface WriteBatchWithInternals extends admin.firestore.WriteBatch {
  _commit: (...args: unknown[]) => Promise<unknown[]>;
  _firestore: FirestoreWithStats;
  _fireway_queue?: Array<() => void>;
}

interface CollectionReferenceWithInternals extends admin.firestore.CollectionReference {
  _firestore: FirestoreWithStats;
}

type WriteBatchCreateFn = (
  this: WriteBatchWithInternals,
  reference: admin.firestore.DocumentReference,
  documentData: admin.firestore.DocumentData,
) => admin.firestore.WriteBatch;

type WriteBatchSetFn = (
  this: WriteBatchWithInternals,
  reference: admin.firestore.DocumentReference,
  documentData: admin.firestore.WithFieldValue<admin.firestore.DocumentData>,
  options?: admin.firestore.SetOptions,
) => admin.firestore.WriteBatch;

type WriteBatchUpdateFn = (
  this: WriteBatchWithInternals,
  reference: admin.firestore.DocumentReference,
  dataOrField: admin.firestore.UpdateData<admin.firestore.DocumentData> | string | admin.firestore.FieldPath,
  ...preconditionOrValues: unknown[]
) => admin.firestore.WriteBatch;

type WriteBatchDeleteFn = (
  this: WriteBatchWithInternals,
  reference: admin.firestore.DocumentReference,
  precondition?: admin.firestore.Precondition,
) => admin.firestore.WriteBatch;

type CollectionAddFn = (
  this: CollectionReferenceWithInternals,
  data: admin.firestore.WithFieldValue<admin.firestore.DocumentData>,
) => Promise<admin.firestore.DocumentReference>;

const statsMap = new Map<MigrationStats, { dryrun: boolean; log: DebugLogger }>();
const skipWriteBatch = Symbol('Skip the WriteBatch proxy');

const dontTrack = Symbol('Skip async tracking to short circuit');
type TrackableFunction = ((...args: unknown[]) => unknown) & { [dontTrack]?: true };
interface StackCallSite {
  getFunction(): TrackableFunction | undefined;
  getFileName(): string | null;
  getLineNumber(): number | null;
  getColumnNumber(): number | null;
}

let proxied = false;
let readCallsites: (() => ReadonlyArray<StackCallSite>) | undefined;

async function loadCallsites(): Promise<() => ReadonlyArray<StackCallSite>> {
  if (!readCallsites) {
    const module = await import('callsites');
    readCallsites = module.default as unknown as () => ReadonlyArray<StackCallSite>;
  }
  return readCallsites;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function getContextsForFirestore(firestore: FirestoreWithStats): Array<{ stats: MigrationStats; dryrun: boolean; log: DebugLogger }> {
  const contexts: Array<{ stats: MigrationStats; dryrun: boolean; log: DebugLogger }> = [];
  for (const [stats, context] of statsMap.entries()) {
    if (firestore._fireway_stats === stats) {
      contexts.push({ stats, dryrun: context.dryrun, log: context.log });
    }
  }
  return contexts;
}

function stringifyValue(value: unknown): string {
  return JSON.stringify(value);
}

function proxyWritableMethods(): void {
  if (proxied) {
    return;
  }
  proxied = true;

  const writeBatchPrototype = admin.firestore.WriteBatch.prototype as unknown as WriteBatchWithInternals;
  const originalCommit = writeBatchPrototype._commit;
  writeBatchPrototype._commit = async function firewayCommitProxy(this: WriteBatchWithInternals, ...args: unknown[]) {
    while (this._fireway_queue?.length) {
      this._fireway_queue.shift()?.();
    }

    for (const context of getContextsForFirestore(this._firestore)) {
      if (context.dryrun) {
        return [];
      }
    }

    return originalCommit.apply(this, args);
  };

  const originalCreate = writeBatchPrototype.create as unknown as WriteBatchCreateFn;
  writeBatchPrototype.create = function firewayCreateProxy(
    this: WriteBatchWithInternals,
    reference: admin.firestore.DocumentReference,
    documentData: admin.firestore.DocumentData,
  ) {
    if (isRecord(documentData) && skipWriteBatch in documentData) {
      delete documentData[skipWriteBatch];
      return originalCreate.call(this, reference, documentData);
    }

    for (const { stats, log } of getContextsForFirestore(this._firestore)) {
      this._fireway_queue = this._fireway_queue ?? [];
      this._fireway_queue.push(() => {
        if (!stats.frozen) {
          stats.created += 1;
        }
        log('Creating', stringifyValue(documentData));
      });
    }

    return originalCreate.call(this, reference, documentData);
  } as unknown as typeof writeBatchPrototype.create;

  const originalSet = writeBatchPrototype.set as unknown as WriteBatchSetFn;
  writeBatchPrototype.set = function firewaySetProxy(
    this: WriteBatchWithInternals,
    reference: admin.firestore.DocumentReference,
    documentData: admin.firestore.WithFieldValue<admin.firestore.DocumentData>,
    options?: admin.firestore.SetOptions,
  ) {
    for (const { stats, log } of getContextsForFirestore(this._firestore)) {
      this._fireway_queue = this._fireway_queue ?? [];
      this._fireway_queue.push(() => {
        if (!stats.frozen) {
          stats.set += 1;
        }
        const isMerge = options !== undefined && 'merge' in options && options.merge === true;
        log(isMerge ? 'Merging' : 'Setting', reference.path, stringifyValue(documentData));
      });
    }

    return originalSet.call(this, reference, documentData, options);
  } as unknown as typeof writeBatchPrototype.set;

  const originalUpdate = writeBatchPrototype.update as unknown as WriteBatchUpdateFn;
  writeBatchPrototype.update = function firewayUpdateProxy(
    this: WriteBatchWithInternals,
    reference: admin.firestore.DocumentReference,
    dataOrField: admin.firestore.UpdateData<admin.firestore.DocumentData> | string | admin.firestore.FieldPath,
    ...preconditionOrValues: unknown[]
  ) {
    for (const { stats, log } of getContextsForFirestore(this._firestore)) {
      this._fireway_queue = this._fireway_queue ?? [];
      this._fireway_queue.push(() => {
        if (!stats.frozen) {
          stats.updated += 1;
        }
        log('Updating', reference.path, stringifyValue(dataOrField));
      });
    }

    return originalUpdate.call(this, reference, dataOrField, ...preconditionOrValues);
  } as unknown as typeof writeBatchPrototype.update;

  const originalDelete = writeBatchPrototype.delete as unknown as WriteBatchDeleteFn;
  writeBatchPrototype.delete = function firewayDeleteProxy(
    this: WriteBatchWithInternals,
    reference: admin.firestore.DocumentReference,
    precondition?: admin.firestore.Precondition,
  ) {
    for (const { stats, log } of getContextsForFirestore(this._firestore)) {
      this._fireway_queue = this._fireway_queue ?? [];
      this._fireway_queue.push(() => {
        if (!stats.frozen) {
          stats.deleted += 1;
        }
        log('Deleting', reference.path);
      });
    }

    return originalDelete.call(this, reference, precondition);
  } as unknown as typeof writeBatchPrototype.delete;

  const collectionPrototype = admin.firestore.CollectionReference.prototype as unknown as CollectionReferenceWithInternals;
  const originalAdd = collectionPrototype.add as unknown as CollectionAddFn;
  collectionPrototype.add = async function firewayAddProxy(
    this: CollectionReferenceWithInternals,
    data: admin.firestore.WithFieldValue<admin.firestore.DocumentData>,
  ) {
    for (const { stats, log } of getContextsForFirestore(this._firestore)) {
      if (isRecord(data)) {
        data[skipWriteBatch] = true;
      }
      if (!stats.frozen) {
        stats.added += 1;
      }
      log('Adding', stringifyValue(data));
    }

    return originalAdd.call(this, data);
  } as unknown as typeof collectionPrototype.add;
}

async function trackAsync<T>(
  options: { log: DebugLogger; file: MigrationFile; forceWait: boolean },
  fn: () => Promise<T>,
): Promise<T | false> {
  const { log, file, forceWait } = options;
  const callsites = await loadCallsites();
  const activeHandles = new Map<number, string>();
  const emitter = new EventEmitter();

  const deleteHandle = (id: number): void => {
    if (activeHandles.has(id)) {
      activeHandles.delete(id);
      emitter.emit('deleted', id);
    }
  };

  const waitForDeleted = (): Promise<void> =>
    new Promise((resolve) => {
      emitter.once('deleted', () => resolve());
    });

  const hook = asyncHooks
    .createHook({
      init(asyncId) {
        for (const call of callsites()) {
          const fnRef = call.getFunction();
          if (fnRef && fnRef[dontTrack]) {
            return;
          }

          const name = call.getFileName();
          if (!name || name === __filename || name.startsWith('internal/') || name.startsWith('timers.js')) {
            continue;
          }

          if (name === file.path) {
            const lineNumber = call.getLineNumber();
            const columnNumber = call.getColumnNumber();
            activeHandles.set(asyncId, `${name}:${lineNumber}:${columnNumber}`);
            break;
          }
        }
      },
      before: deleteHandle,
      after: deleteHandle,
      promiseResolve: deleteHandle,
    })
    .enable();

  let logged = false;
  const handleCheck = async (): Promise<void> => {
    while (activeHandles.size) {
      if (forceWait) {
        if (!logged) {
          log('Waiting for async calls to resolve');
          logged = true;
        }
        await waitForDeleted();
      } else {
        const nodeVersion = semver.coerce(process.versions.node);
        if (nodeVersion && nodeVersion.major >= 12) {
          console.warn(
            'WARNING: ts-fireway detected open async calls. Use --forceWait if you want to wait:',
            Array.from(activeHandles.values()),
          );
        }
        break;
      }
    }
  };

  let rejection: unknown;
  const unhandled = (reason: unknown): void => {
    rejection = reason;
  };

  process.once('unhandledRejection', unhandled);
  process.once('uncaughtException', unhandled);

  try {
    const result = await fn();
    await handleCheck();
    await new Promise<void>((resolve) => setTimeout(resolve, 1));

    process.off('unhandledRejection', unhandled);
    process.off('uncaughtException', unhandled);

    if (rejection) {
      log(`Error in ${file.filename}`, rejection);
      return false;
    }

    return result;
  } catch (error) {
    log(error);
    return false;
  } finally {
    hook.disable();
  }
}

(trackAsync as unknown as TrackableFunction)[dontTrack] = true;

function resolveMigrateFunction(moduleValue: unknown): MigrationModule['migrate'] {
  if (isRecord(moduleValue) && typeof moduleValue.migrate === 'function') {
    return moduleValue.migrate as MigrationModule['migrate'];
  }

  if (isRecord(moduleValue) && isRecord(moduleValue.default) && typeof moduleValue.default.migrate === 'function') {
    return moduleValue.default.migrate as MigrationModule['migrate'];
  }

  throw new Error('Migration module must export a `migrate` function');
}

function buildAppOptions(projectId: string | undefined, storageBucket: string | undefined): admin.AppOptions {
  const options: admin.AppOptions = {};
  if (projectId) {
    options.projectId = projectId;
  }
  if (storageBucket) {
    options.storageBucket = storageBucket;
  }
  return options;
}

function buildMigrationResult(params: {
  installed_rank: number;
  file: MigrationFile;
  checksum: string;
  start: Date;
  finish: Date;
  success: boolean;
}): Record<string, unknown> {
  const { installed_rank, file, checksum, start, finish, success } = params;
  return {
    installed_rank,
    description: file.description,
    version: file.version,
    script: file.filename,
    type: path.extname(file.filename).slice(1),
    checksum,
    installed_by: os.userInfo().username,
    installed_on: start,
    execution_time: finish.getTime() - start.getTime(),
    success,
  };
}

export async function migrate(params: MigrateParams = {}): Promise<MigrationStats> {
  let {
    path: dir = './migrations',
    projectId,
    storageBucket,
    dryrun = false,
    app,
    debug = false,
    require: requireModule,
    forceWait = false,
    databaseId,
  } = params;

  if (requireModule) {
    try {
      require(requireModule);
    } catch (error) {
      console.error(error);
      throw new Error(`Trouble executing require('${requireModule}');`);
    }
  }

  const log: DebugLogger = (...args) => {
    if (debug) {
      console.log(...args);
    }
  };

  const stats: MigrationStats = {
    scannedFiles: 0,
    executedFiles: 0,
    created: 0,
    set: 0,
    updated: 0,
    deleted: 0,
    added: 0,
  };

  if (!path.isAbsolute(dir)) {
    dir = path.join(process.cwd(), dir);
  }

  try {
    await fs.access(dir);
  } catch {
    throw new Error(`No directory at ${dir}`);
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const filenames = entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name);

  const versionToFile = new Map<string, string>();
  let files = filenames
    .map((filename): MigrationFile | null => {
      if (filename.startsWith('.')) {
        return null;
      }

      const [filenameVersion, description] = filename.split('__');
      const coerced = semver.coerce(filenameVersion);

      if (!coerced) {
        if (description) {
          log(`WARNING: ${filename} doesn't have a valid semver version`);
        }
        return null;
      }

      if (!description) {
        throw new Error(`This filename doesn't match the required format: ${filename}`);
      }

      const { version } = coerced;
      const existingFile = versionToFile.get(version);
      if (existingFile) {
        throw new Error(`Both ${filename} and ${existingFile} have the same version`);
      }
      versionToFile.set(version, filename);

      return {
        filename,
        path: path.join(dir, filename),
        version,
        description: path.basename(description, path.extname(description)),
      };
    })
    .filter((file): file is MigrationFile => file !== null);

  stats.scannedFiles = files.length;
  log(`Found ${stats.scannedFiles} migration files`);

  statsMap.set(stats, { dryrun, log });
  if (dryrun) {
    log('Making firestore read-only');
  }
  proxyWritableMethods();

  if (!storageBucket && projectId) {
    storageBucket = `${projectId}.appspot.com`;
  }

  const providedApp = app;
  if (!app) {
    app = admin.initializeApp(buildAppOptions(projectId, storageBucket));
  }

  const firestoreOptions: admin.firestore.Settings = {};
  if (projectId) {
    firestoreOptions.projectId = projectId;
  }
  if (databaseId) {
    firestoreOptions.databaseId = databaseId;
  }

  const firestore = new admin.firestore.Firestore(firestoreOptions) as FirestoreWithStats;
  firestore._fireway_stats = stats;

  const collection = firestore.collection('fireway');
  const result = await collection.orderBy('installed_rank', 'desc').limit(1).get();
  const latestDoc = result.docs.at(0);
  const latest = latestDoc?.data() as MigrationRecord | undefined;

  if (latest && !latest.success) {
    throw new Error(
      `Migration to version ${latest.version} using ${latest.script} failed! Please restore backups and roll back database and code!`,
    );
  }

  let installed_rank: number;
  if (latest) {
    files = files.filter((file) => semver.gt(file.version, latest.version));
    installed_rank = latest.installed_rank;
  } else {
    installed_rank = -1;
  }

  files.sort((first, second) => semver.compare(first.version, second.version));
  log(`Executing ${files.length} migration files`);

  try {
    for (const file of files) {
      stats.executedFiles += 1;
      log('Running', file.filename);

      let migrationFunction: MigrationModule['migrate'];
      try {
        const migrationModule = require(file.path) as unknown;
        migrationFunction = resolveMigrateFunction(migrationModule);
      } catch (error) {
        log(error);
        throw error;
      }

      let start = new Date();
      let finish = new Date();
      const success = await trackAsync({ log, file, forceWait }, async () => {
        start = new Date();
        try {
          await migrationFunction({
            app,
            firestore,
            FieldValue: admin.firestore.FieldValue,
            FieldPath: admin.firestore.FieldPath,
            Timestamp: admin.firestore.Timestamp,
            dryrun,
          });
          return true;
        } catch (error) {
          log(`Error in ${file.filename}`, error);
          return false;
        } finally {
          finish = new Date();
        }
      });

      log(`Uploading the results for ${file.filename}`);
      stats.frozen = true;

      installed_rank += 1;
      const id = `${installed_rank}-${file.version}-${file.description}`;
      const checksum = md5(await fs.readFile(file.path));

      await collection.doc(id).set(
        buildMigrationResult({
          installed_rank,
          file,
          checksum,
          start,
          finish,
          success: success === true,
        }),
      );

      delete stats.frozen;

      if (!success) {
        throw new Error('Stopped at first failure');
      }
    }

    if (!providedApp) {
      await app.delete();
    }

    const { scannedFiles, executedFiles, added, created, updated, set, deleted } = stats;
    log('Finished all firestore migrations');
    log(`Files scanned:${scannedFiles} executed:${executedFiles}`);
    log(`Docs added:${added} created:${created} updated:${updated} set:${set} deleted:${deleted}`);

    return stats;
  } finally {
    statsMap.delete(stats);
  }
}
