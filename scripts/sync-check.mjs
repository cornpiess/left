#!/usr/bin/env node
/**
 * Session start/end guard for the two-machine workflow.
 *
 * Run `npm run sync:check` at the start of every working session (and again
 * before you switch machines). It reports whether this clone is aligned with
 * the shared remote so work never silently forks again.
 *
 * Exit codes: 0 = healthy, 1 = needs push or pull, 2 = diverged (both ahead
 * and behind) which must be reconciled before writing any new code.
 */
import { execFileSync } from 'node:child_process';

const run = (args, opts = {}) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch {
    return null;
  }
};

const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']) || '(detached)';
const upstream = run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);

console.log(`branch     : ${branch}`);
if (upstream) console.log(`upstream   : ${upstream}`);
else console.log('upstream   : (none — set one with: git push -u origin <branch>)');

// Fetch silently — may fail offline; the report still works from local refs.
// Short http timeouts keep this command snappy when the network is down.
try {
  execFileSync(
    'git',
    [
      '-c', 'http.connectTimeout=8',
      '-c', 'http.lowSpeedLimit=1',
      '-c', 'http.lowSpeedTime=8',
      'fetch', 'origin',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }
  );
} catch {
  console.log('fetch      : OFFLINE — could not reach origin (stale comparison below)');
}

const dirty = (run(['status', '--porcelain']) || '').split('\n').filter((l) => l.length).length;
console.log(`dirty files: ${dirty}`);

if (upstream) {
  const counts = run(['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  if (counts) {
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    console.log(`vs origin  : ahead ${ahead}, behind ${behind}`);
    const lastLocal = run(['log', '-1', '--format=%ci', 'HEAD']) || '';
    const lastRemote = run(['log', '-1', '--format=%ci', '@{u}']) || '';
    console.log(`last commit: local ${lastLocal}`);
    console.log(`              remote ${lastRemote}`);

    const verdict = [];
    if (behind > 0) verdict.push(`RUN \`git pull --ff-only\` (you are ${behind} behind origin/master)`);
    if (ahead > 0) verdict.push(`RUN \`git push origin master\` (you are ${ahead} ahead of origin/master)`);
    if (behind > 0 && ahead > 0) {
      console.log('\n⚠️  DIVERGED: local master has BOTH unpushed commits AND is behind origin/master.');
      console.log('   STOP — reconcile (merge/rebase origin/master) BEFORE writing any new code.');
      console.log('   The two lines may have independently changed the same files.');
      process.exitCode = 2;
    } else if (behind > 0 || ahead > 0) {
      console.log(`\n▶ ${verdict.join('\n▶ ')}`);
      process.exitCode = 1;
    } else {
      console.log('\n✓ aligned with origin/master');
    }
  } else {
    console.log('vs origin  : (cannot compare)');
  }
}

if (dirty > 0) {
  console.log(`\n⚠ ${dirty} uncommitted change(s) — commit before switching machines.`);
  if (process.exitCode === undefined) process.exitCode = 1;
}

if (process.exitCode === undefined) process.exitCode = 0;
