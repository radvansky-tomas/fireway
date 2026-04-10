# ts-fireway
A schema migration tool for firestore heavily inspired by [flyway](https://flywaydb.org/)

## Install

```bash
yarn global add ts-fireway

# or 

npx ts-fireway
```

## Credentials

In order for `ts-fireway` to connect to firestore you need to set up the environment variable `GOOGLE_APPLICATION_CREDENTIALS` with service account file path.

Example:
```bash
export GOOGLE_APPLICATION_CREDENTIALS="path/to/firestore-service-account.json"
```

## CLI

```bash
Usage
  $ ts-fireway <command> [options]

Available Commands
  migrate    Migrates schema to the latest version

For more info, run any command with the `--help` flag
  $ ts-fireway migrate --help

Options
  --require        Requires a module before executing
  -v, --version    Displays current version
  -h, --help       Displays this message

Examples
  $ ts-fireway migrate
  $ ts-fireway --require="ts-node/register" migrate
```

### `ts-fireway migrate`
```bash
Description
  Migrates schema to the latest version

Usage
  $ ts-fireway migrate [options]

Options
  --path         Path to migration files  (default ./migrations)
  --projectId    Target firebase project
  --dryrun       Simulates changes
  --forceWait    Forces waiting for migrations that do not strictly manage async calls
  --require      Requires a module before executing
  --databaseId   Firestore databaseId (default is (default))
  -h, --help     Displays this message

Examples
  $ ts-fireway migrate
  $ ts-fireway migrate --path=./my-migrations
  $ ts-fireway migrate --projectId=my-staging-id
  $ ts-fireway migrate --dryrun
  $ ts-fireway migrate --forceWait
  $ ts-fireway migrate --databaseId=custom-db
  $ ts-fireway --require="ts-node/register" migrate
```

## Migration file format

Migration file name format: `v[semver]__[description].js`

```js
// each script gets a pre-configured Firebase Admin context
// possible params: app, auth, storage, firestore, FieldValue, FieldPath, Timestamp, dryrun
module.exports.migrate = async ({firestore, FieldValue, auth, storage}) => {
    await firestore.collection('name').add({key: FieldValue.serverTimestamp()});
};
```

## Typed Migrations

For type checking and Intellisense, there are two options:

### TypeScript

1. Ensure [`ts-node`](https://www.npmjs.com/package/ts-node) is installed
2. Define a `ts-node` configuration block inside your `tsconfig.json` file:

   ```json
   {
     "ts-node": {
       "transpileOnly": true,
       "compilerOptions": {
         "module": "commonjs"
       }
     }
   }
   ```
3. Create a migration

   ```ts
    // ./migrations/v0.0.1__typescript-example.ts

    import { MigrateOptions } from 'ts-fireway';

    export async function migrate({firestore} : MigrateOptions) {
        await firestore.collection('data').doc('one').set({key: 'value'});
    };
   ```
4. Run `ts-fireway migrate` with the `require` option

   ```sh
   $ ts-fireway migrate --require="ts-node/register"
   ```

### JSDoc

Alternatively, you can use [JSDoc](https://jsdoc.app/) for Intellisense

```js
/** @param { import('ts-fireway').MigrateOptions } */
module.exports.migrate = async ({firestore}) => {
    // Intellisense is enabled
};
```

## Running locally

Typically, `ts-fireway` expects a `--projectId` option that lets you specify the Firebase project associated with your Firestore instance against which it performs migrations. 
However, most likely you'll want to test your migration scripts _locally_ first before running them against your actual (presumably, production) instances. 
If you are using the [Firestore emulator](https://firebase.google.com/docs/emulator-suite/connect_firestore), define the FIRESTORE_EMULATOR_HOST environment variable, e.g.:

`export FIRESTORE_EMULATOR_HOST="localhost:8080"`

The firestore node library will connect to your local instance. This way, you don't need a project ID and migrations will be run against your emulator instance. This works since `ts-fireway` is built on the [firestore node library](https://www.npmjs.com/package/@google-cloud/firestore). 

## Migration logic

1. Gather all the migration files and sort them according to semver
2. Find the last migration in the `fireway` collection
3. If the last migration failed, stop. (remove the failed migration result or restore the db to continue)
4. Run the migration scripts since the last migration

## Migration results

Migration results are stored in the `fireway` collection in `firestore`

```js
// /fireway/3-0.0.1-example

{
  checksum: 'fdfe6a55a7c97a4346cb59871b4ce97c',
  description: 'example',
  execution_time: 1221,
  installed_by: 'system_user_name',
  installed_on: firestore.Timestamp(),
  installed_rank: 3,
  script: 'v0.0.1__example.js',
  success: true,
  type: 'js',
  version: '0.0.1'
}
```

## Contributing

```bash
# To install packages and firestore emulator
$ yarn
$ yarn setup

# To run tests
$ yarn test
```

## Credits

- Original project and foundation: Kevin Ledenev (`kevlened`, `boyettel@gmail.com`)
- This TypeScript-forward fork/maintenance: Tomas Radvansky (`radvansky.tomas@gmail.com`)

## License

MIT
