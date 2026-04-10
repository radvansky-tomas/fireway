#!/usr/bin/env node

import sade from 'sade';
import { migrate } from './index';
import pkg from '../package.json';

interface CliOptions {
  require?: string;
  path?: string;
  projectId?: string;
  dryrun?: boolean;
  forceWait?: boolean;
  quiet?: boolean;
  databaseId?: string;
  debug?: boolean;
}

const program = sade('ts-fireway').version(pkg.version);

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
  .action(async (opts: CliOptions) => {
    try {
      opts.debug = !opts.quiet;
      await migrate(opts);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.log('ERROR:', message);
      process.exit(1);
    }
  });

program.parse(process.argv);
