#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const sade_1 = __importDefault(require("sade"));
const index_1 = require("./index");
const package_json_1 = __importDefault(require("../package.json"));
const program = (0, sade_1.default)('ts-fireway').version(package_json_1.default.version);
program
    .option('--require', 'Requires a module before executing')
    .example('migrate')
    .example('--require="ts-node/register" migrate')
    .command('migrate')
    .option('--path', 'Path to migration files', './migrations')
    .option('--projectId', 'Target firebase project')
    .option('--dryrun', 'Simulates changes')
    .option('--forceWait', 'Forces waiting for migrations that do not strictly manage async calls')
    .option('--quiet', "disables console debug logging within ts-fireway's migrate")
    .option('--databaseId', 'Firestore databaseId (default is (default))')
    .describe('Migrates schema to the latest version')
    .example('migrate')
    .example('migrate --path=./my-migrations')
    .example('migrate --projectId=my-staging-id')
    .example('migrate --dryrun')
    .example('migrate --forceWait')
    .example('migrate --quiet')
    .example('--require="ts-node/register" migrate')
    .action(async (opts) => {
    try {
        opts.debug = !opts.quiet;
        await (0, index_1.migrate)(opts);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log('ERROR:', message);
        process.exit(1);
    }
});
program.parse(process.argv);
//# sourceMappingURL=cli.js.map