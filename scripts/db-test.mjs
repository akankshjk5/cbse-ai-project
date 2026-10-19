#!/usr/bin/env node
/**
 * Run the SQL suites against a real PostgreSQL, in a database it throws away.
 *
 *   npm run test:db
 *   npm run test:db -- --keep          leave the database for inspection
 *   npm run test:db -- --suite source_rights
 *
 * There was no runner before this. The four suites in `supabase/tests/` carried
 * instructions in their header comments and were run by hand, which is why
 * `reuse_concurrency.sql` had been broken for some time without anyone
 * noticing: it could not reach its own second property.
 *
 * Connection comes from DATABASE_URL, or PGHOST/PGPORT/PGUSER/PGPASSWORD, or
 * the local defaults. No password is read from a file and none is printed.
 *
 * Two deliberate departures from production, both reported on every run:
 *
 *  - `pgvector` is skipped when the server does not have it. The `vector`
 *    extension line is commented out and `*_rag.sql` is not applied. Nothing in
 *    the reuse, asset or rights objects depends on either, and a server without
 *    pgvector would otherwise fail at the second migration and take all four
 *    suites with it. A run that skipped them says so, so no one can read this
 *    as a full-schema check.
 *  - `supabase/tests/00_supabase_shim.sql` stands in for the parts of Supabase
 *    that are not in this repository: the auth and storage schemas, the roles,
 *    and `auth.jwt()`.
 *
 * This proves the database behaves. It does not prove the deployed Supabase
 * project behaves, because that one has real RLS, real roles and real data.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const SUITES = ['shared_asset_reuse', 'asset_lifecycle', 'source_rights', 'reuse_concurrency',
  'deck_jobs'];
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const only = args.includes('--suite') ? args[args.indexOf('--suite') + 1] : null;

/** psql is not on PATH on Windows installs; look where it actually lands. */
function findPsql() {
  const fromEnv = process.env.PSQL;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['psql'],
      { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  } catch { /* not on PATH */ }
  const roots = ['C:/Program Files/PostgreSQL', 'C:/Program Files (x86)/PostgreSQL'];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const versions = readdirSync(root).sort((a, b) => Number(b) - Number(a));
    for (const v of versions) {
      const candidate = join(root, v, 'bin', 'psql.exe');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const PSQL = findPsql();
if (!PSQL) {
  console.error('Could not find psql. Install PostgreSQL client tools, or set PSQL to its path.');
  process.exit(2);
}

const conn = process.env.DATABASE_URL ?? null;
const host = process.env.PGHOST ?? '127.0.0.1';
const port = process.env.PGPORT ?? '5432';
const user = process.env.PGUSER ?? 'postgres';

function connArgs(db) {
  return conn
    ? ['-d', conn.replace(/\/[^/]*$/, `/${db}`)]
    : ['-h', host, '-p', port, '-U', user, '-d', db];
}

/**
 * Run psql and return BOTH streams.
 *
 * psql writes `raise notice` to stderr, which is where every "ok:" line in
 * these suites goes. An earlier version of this runner counted them from
 * stdout, found none, and printed "PASS  0 properties" for all four suites --
 * green, and proving nothing.
 */
function psql(db, extra) {
  const result = spawnSync(PSQL, [...connArgs(db), '-v', 'ON_ERROR_STOP=1', '-q', ...extra],
    { encoding: 'utf8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.status !== 0) {
    const error = new Error(`psql exited ${result.status}`);
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }
  return { stdout, stderr, all: `${stdout}\n${stderr}` };
}

function serverHasVector(db) {
  try {
    return psql(db, ['-tAc', "select 1 from pg_available_extensions where name = 'vector'"])
      .stdout.trim() === '1';
  } catch { return false; }
}

const dbName = `lumina_test_${Date.now().toString(36)}`;
let work = null;
let created = false;
let failures = 0;
let total = 0;

try {
  const hasVector = serverHasVector('postgres');
  psql('postgres', ['-c', `CREATE DATABASE ${dbName}`]);
  created = true;
  console.log(`database ${dbName}  ·  pgvector ${hasVector ? 'available' : 'MISSING — rag migration will be skipped'}`);

  // Stage the migrations so the repository is never modified.
  work = mkdtempSync(join(tmpdir(), 'lumina-mig-'));
  const migDir = 'supabase/migrations';
  let skipped = [];
  for (const file of readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) {
    const target = join(work, file);
    copyFileSync(join(migDir, file), target);
    if (hasVector) continue;
    const body = readFileSync(target, 'utf8');
    if (/extensions\.vector|vector\(/.test(body) && !/create extension/.test(body)) {
      unlinkSync(target);                 // a migration that needs the type itself
      skipped.push(basename(file));
      continue;
    }
    if (/create extension if not exists "vector"/.test(body)) {
      writeFileSync(target, body.replace(
        /create extension if not exists "vector".*$/m,
        '-- [test harness] pgvector unavailable on this server; stubbed'), 'utf8');
      skipped.push(`${basename(file)} (vector extension line only)`);
    }
  }

  psql(dbName, ['-f', 'supabase/tests/00_supabase_shim.sql']);
  const staged = readdirSync(work).filter((f) => f.endsWith('.sql')).sort();
  for (const file of staged) psql(dbName, ['-f', join(work, file)]);
  console.log(`applied shim + ${staged.length} migrations`);
  if (skipped.length) console.log(`skipped for pgvector: ${skipped.join(', ')}`);
  console.log('');

  for (const suite of SUITES) {
    if (only && suite !== only) continue;
    process.stdout.write(`  ${suite.padEnd(22)}`);
    try {
      const out = psql(dbName, ['-f', `supabase/tests/${suite}.sql`]);
      // Counted from both streams, and zero is a failure: a suite that asserts
      // nothing must not report success just because psql exited 0.
      //
      // Both spellings. reuse_concurrency.sql writes `raise notice 'ok: ...'`
      // and the other three write `raise notice 'ok  ...'`. Matching only the
      // colon form counted 7, 10 and 9 real properties as zero.
      const oks = (out.all.match(/NOTICE:\s+ok/g) ?? []).length;
      if (oks === 0) {
        failures += 1;
        console.log('FAIL\n      exited 0 but reported no properties — nothing was asserted');
        continue;
      }
      total += oks;
      console.log(`PASS  ${oks} propert${oks === 1 ? 'y' : 'ies'}`);
    } catch (error) {
      failures += 1;
      const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      const first = text.split(/\r?\n/).find((l) => /ERROR/.test(l)) ?? 'failed';
      console.log(`FAIL\n      ${first.trim()}`);
    }
  }
} catch (error) {
  console.error(`\nsetup failed: ${(error.stderr ?? error.message ?? '').toString().trim().split('\n')[0]}`);
  failures += 1;
} finally {
  if (work) rmSync(work, { recursive: true, force: true });
  if (created && !keep) {
    try { psql('postgres', ['-c', `DROP DATABASE ${dbName}`]); } catch { /* best effort */ }
  } else if (created) {
    console.log(`\nkept ${dbName}`);
  }
}

console.log(failures === 0
  ? `\nOK — ${total} properties asserted against PostgreSQL`
  : `\n${failures} suite(s) failed`);
process.exit(failures === 0 ? 0 : 1);
