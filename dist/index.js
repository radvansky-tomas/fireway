"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrate = migrate;
const node_path_1 = __importDefault(require("node:path"));
const node_events_1 = require("node:events");
const node_os_1 = __importDefault(require("node:os"));
const promises_1 = __importDefault(require("node:fs/promises"));
const node_async_hooks_1 = __importDefault(require("node:async_hooks"));
const md5_1 = __importDefault(require("md5"));
const admin = __importStar(require("firebase-admin"));
const semver_1 = __importDefault(require("semver"));
const statsMap = new Map();
const skipWriteBatch = Symbol('Skip the WriteBatch proxy');
const dontTrack = Symbol('Skip async tracking to short circuit');
let proxied = false;
let readCallsites;
async function loadCallsites() {
    if (!readCallsites) {
        const module = await import('callsites');
        readCallsites = module.default;
    }
    return readCallsites;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function getContextsForFirestore(firestore) {
    const contexts = [];
    for (const [stats, context] of statsMap.entries()) {
        if (firestore._fireway_stats === stats) {
            contexts.push({ stats, dryrun: context.dryrun, log: context.log });
        }
    }
    return contexts;
}
function stringifyValue(value) {
    return JSON.stringify(value);
}
function proxyWritableMethods() {
    if (proxied) {
        return;
    }
    proxied = true;
    const writeBatchPrototype = admin.firestore.WriteBatch.prototype;
    const originalCommit = writeBatchPrototype._commit;
    writeBatchPrototype._commit = async function firewayCommitProxy(...args) {
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
    const originalCreate = writeBatchPrototype.create;
    writeBatchPrototype.create = function firewayCreateProxy(reference, documentData) {
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
    };
    const originalSet = writeBatchPrototype.set;
    writeBatchPrototype.set = function firewaySetProxy(reference, documentData, options) {
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
    };
    const originalUpdate = writeBatchPrototype.update;
    writeBatchPrototype.update = function firewayUpdateProxy(reference, dataOrField, ...preconditionOrValues) {
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
    };
    const originalDelete = writeBatchPrototype.delete;
    writeBatchPrototype.delete = function firewayDeleteProxy(reference, precondition) {
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
    };
    const collectionPrototype = admin.firestore.CollectionReference.prototype;
    const originalAdd = collectionPrototype.add;
    collectionPrototype.add = async function firewayAddProxy(data) {
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
    };
}
async function trackAsync(options, fn) {
    const { log, file, forceWait } = options;
    const callsites = await loadCallsites();
    const activeHandles = new Map();
    const emitter = new node_events_1.EventEmitter();
    const deleteHandle = (id) => {
        if (activeHandles.has(id)) {
            activeHandles.delete(id);
            emitter.emit('deleted', id);
        }
    };
    const waitForDeleted = () => new Promise((resolve) => {
        emitter.once('deleted', () => resolve());
    });
    const hook = node_async_hooks_1.default
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
    const handleCheck = async () => {
        while (activeHandles.size) {
            if (forceWait) {
                if (!logged) {
                    log('Waiting for async calls to resolve');
                    logged = true;
                }
                await waitForDeleted();
            }
            else {
                const nodeVersion = semver_1.default.coerce(process.versions.node);
                if (nodeVersion && nodeVersion.major >= 12) {
                    console.warn('WARNING: ts-fireway detected open async calls. Use --forceWait if you want to wait:', Array.from(activeHandles.values()));
                }
                break;
            }
        }
    };
    let rejection;
    const unhandled = (reason) => {
        rejection = reason;
    };
    process.once('unhandledRejection', unhandled);
    process.once('uncaughtException', unhandled);
    try {
        const result = await fn();
        await handleCheck();
        await new Promise((resolve) => setTimeout(resolve, 1));
        process.off('unhandledRejection', unhandled);
        process.off('uncaughtException', unhandled);
        if (rejection) {
            log(`Error in ${file.filename}`, rejection);
            return false;
        }
        return result;
    }
    catch (error) {
        log(error);
        return false;
    }
    finally {
        hook.disable();
    }
}
trackAsync[dontTrack] = true;
function resolveMigrateFunction(moduleValue) {
    if (isRecord(moduleValue) && typeof moduleValue.migrate === 'function') {
        return moduleValue.migrate;
    }
    if (isRecord(moduleValue) && isRecord(moduleValue.default) && typeof moduleValue.default.migrate === 'function') {
        return moduleValue.default.migrate;
    }
    throw new Error('Migration module must export a `migrate` function');
}
function buildAppOptions(projectId, storageBucket) {
    const options = {};
    if (projectId) {
        options.projectId = projectId;
    }
    if (storageBucket) {
        options.storageBucket = storageBucket;
    }
    return options;
}
function buildMigrationResult(params) {
    const { installed_rank, file, checksum, start, finish, success } = params;
    return {
        installed_rank,
        description: file.description,
        version: file.version,
        script: file.filename,
        type: node_path_1.default.extname(file.filename).slice(1),
        checksum,
        installed_by: node_os_1.default.userInfo().username,
        installed_on: start,
        execution_time: finish.getTime() - start.getTime(),
        success,
    };
}
async function migrate(params = {}) {
    let { path: dir = './migrations', projectId, storageBucket, dryrun = false, app, debug = false, require: requireModule, forceWait = false, databaseId, } = params;
    if (requireModule) {
        try {
            require(requireModule);
        }
        catch (error) {
            console.error(error);
            throw new Error(`Trouble executing require('${requireModule}');`);
        }
    }
    const log = (...args) => {
        if (debug) {
            console.log(...args);
        }
    };
    const stats = {
        scannedFiles: 0,
        executedFiles: 0,
        created: 0,
        set: 0,
        updated: 0,
        deleted: 0,
        added: 0,
    };
    if (!node_path_1.default.isAbsolute(dir)) {
        dir = node_path_1.default.join(process.cwd(), dir);
    }
    try {
        await promises_1.default.access(dir);
    }
    catch {
        throw new Error(`No directory at ${dir}`);
    }
    const entries = await promises_1.default.readdir(dir, { withFileTypes: true });
    const filenames = entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
    const versionToFile = new Map();
    let files = filenames
        .map((filename) => {
        if (filename.startsWith('.')) {
            return null;
        }
        const [filenameVersion, description] = filename.split('__');
        const coerced = semver_1.default.coerce(filenameVersion);
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
            path: node_path_1.default.join(dir, filename),
            version,
            description: node_path_1.default.basename(description, node_path_1.default.extname(description)),
        };
    })
        .filter((file) => file !== null);
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
    const firestoreOptions = {};
    if (projectId) {
        firestoreOptions.projectId = projectId;
    }
    if (databaseId) {
        firestoreOptions.databaseId = databaseId;
    }
    const firestore = new admin.firestore.Firestore(firestoreOptions);
    firestore._fireway_stats = stats;
    const collection = firestore.collection('fireway');
    const result = await collection.orderBy('installed_rank', 'desc').limit(1).get();
    const latestDoc = result.docs.at(0);
    const latest = latestDoc?.data();
    if (latest && !latest.success) {
        throw new Error(`Migration to version ${latest.version} using ${latest.script} failed! Please restore backups and roll back database and code!`);
    }
    let installed_rank;
    if (latest) {
        files = files.filter((file) => semver_1.default.gt(file.version, latest.version));
        installed_rank = latest.installed_rank;
    }
    else {
        installed_rank = -1;
    }
    files.sort((first, second) => semver_1.default.compare(first.version, second.version));
    log(`Executing ${files.length} migration files`);
    try {
        for (const file of files) {
            stats.executedFiles += 1;
            log('Running', file.filename);
            let migrationFunction;
            try {
                const migrationModule = require(file.path);
                migrationFunction = resolveMigrateFunction(migrationModule);
            }
            catch (error) {
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
                }
                catch (error) {
                    log(`Error in ${file.filename}`, error);
                    return false;
                }
                finally {
                    finish = new Date();
                }
            });
            log(`Uploading the results for ${file.filename}`);
            stats.frozen = true;
            installed_rank += 1;
            const id = `${installed_rank}-${file.version}-${file.description}`;
            const checksum = (0, md5_1.default)(await promises_1.default.readFile(file.path));
            await collection.doc(id).set(buildMigrationResult({
                installed_rank,
                file,
                checksum,
                start,
                finish,
                success: success === true,
            }));
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
    }
    finally {
        statsMap.delete(stats);
    }
}
//# sourceMappingURL=index.js.map