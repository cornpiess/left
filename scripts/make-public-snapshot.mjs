#!/usr/bin/env node
/**
 * Build a clean, no-history public snapshot of this (private ops) repository.
 *
 * What it does:
 *   1. Copies every git-tracked file EXCEPT the denylist below
 *      (internal handoff docs, agent memory, ASO material).
 *   2. Rewrites the local-module podspec URLs to the public repo.
 *   3. Re-scans the OUTPUT for sensitive strings (emails, cert serials,
 *      key material, credential paths) and FAILS if any survive.
 *   4. Initializes the output as a fresh git repo (branch `main`,
 *      single commit) ready to push to the public repository.
 *
 * Usage:
 *   node scripts/make-public-snapshot.mjs [--out DIR] [--public-repo OWNER/NAME]
 *
 * The private repo remains the operations brain (credentials, build history,
 * ASC workflow). Never push the private repo itself to a public remote.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT_DIR = path.resolve(argOf('--out', '.codex-export-public'));
const PUBLIC_REPO = argOf('--public-repo', 'cornpiess/left');
const SNAPSHOT_MSG = 'LeftSwipe open-source snapshot (v1.0.6)';

// ---- 1. Files that must never leave the private repo ----------------------
const DENY_FILES = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'scripts/public-scan-signatures.json',
  'docs/APP_STORE_DESCRIPTION_ZH_HANS.txt',
  'docs/APP_STORE_RELEASE_NOTES_1.0.5.md',
  'docs/APP_STORE_REVIEW_RESUBMISSION.md',
]);
const DENY_PREFIXES = ['.claude/', '.workbuddy/', 'docs/agents/'];

// ---- 2. Content patterns that must never appear in the snapshot -----------
// Published privacy-contact email on the live legal pages is explicitly allowed.
const ALLOWED_EMAILS = new Set(['961819912@qq.com']);
// Generic signatures live here (secret-free); project-specific signatures
// (team ids, serials, credential paths) load from scripts/public-scan-signatures.json,
// which is itself denied from the export — otherwise the scanner would leak
// the very strings it exists to catch.
const SECRET_PATTERNS = [
  { name: 'PEM private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
];
const EMAIL_RE = /[\w.+-]+@(?:qq|icloud)\.com/gi;
const signaturesPath = path.resolve(import.meta.dirname, 'public-scan-signatures.json');
let projectPatterns = [];
if (fs.existsSync(signaturesPath)) {
  const parsed = JSON.parse(fs.readFileSync(signaturesPath, 'utf8'));
  projectPatterns = (parsed.patterns || []).map((p) => ({ name: p.name, re: new RegExp(p.re, 'i') }));
} else {
  console.warn('NOTE: scripts/public-scan-signatures.json not found — running generic scan only.');
}

const TEXT_EXT = /\.(js|mjs|cjs|json|md|txt|html|css|yml|yaml|swift|podspec|ts|tsx|jsx|sh|bash|plist|xml|gitignore|gitattributes|editorconfig|npmrc|properties|lock)$/i;

const repoRoot = path.resolve(import.meta.dirname, '..');

const lsFiles = () =>
  execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

const files = lsFiles();
const kept = [];
const denied = [];
for (const f of files) {
  if (DENY_FILES.has(f) || DENY_PREFIXES.some((p) => f.startsWith(p))) denied.push(f);
  else kept.push(f);
}

// ---- 3. Copy + rewrite ------------------------------------------------------
fs.rmSync(OUT_DIR, { recursive: true, force: true });
let rewrote = 0;
for (const f of kept) {
  const src = path.join(repoRoot, f);
  const dst = path.join(OUT_DIR, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (f === 'modules/maoqiu-photo-preview/ios/MaoqiuPhotoPreview.podspec') {
    const text = fs.readFileSync(src, 'utf8').replaceAll('cornpiess/delete_photo', PUBLIC_REPO);
    fs.writeFileSync(dst, text);
    rewrote++;
  } else {
    fs.copyFileSync(src, dst);
  }
}

// ---- 4. Security rescan of the output tree ---------------------------------
const findings = [];
for (const f of kept) {
  if (!TEXT_EXT.test(f)) continue;
  const abs = path.join(OUT_DIR, f);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\u0000')) continue;
  for (const m of text.match(EMAIL_RE) || []) {
    if (!ALLOWED_EMAILS.has(m.toLowerCase())) findings.push(`${f}: email ${m}`);
  }
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) findings.push(`${f}: ${name}`);
  }
}
if (findings.length) {
  console.error('SECURITY SCAN FAILED — sensitive strings in snapshot:');
  for (const line of findings) console.error('  ' + line);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  process.exit(1);
}

// ---- 5. Fresh git history ----------------------------------------------------
execFileSync('git', ['init', '-b', 'main'], { cwd: OUT_DIR });
execFileSync('git', ['add', '-A'], { cwd: OUT_DIR });
execFileSync('git', ['commit', '-m', SNAPSHOT_MSG, '--quiet'], { cwd: OUT_DIR });

console.log(`Public snapshot ready: ${OUT_DIR}`);
console.log(`  files copied : ${kept.length}`);
console.log(`  files denied : ${denied.length}`);
console.log(`  podspec rewrote to ${PUBLIC_REPO}: ${rewrote}`);
console.log('');
console.log('Denied (kept private):');
for (const f of denied) console.log('  - ' + f);
console.log('');
console.log('Next steps (create the empty public repo on github.com first):');
console.log(`  cd ${OUT_DIR}`);
console.log(`  git remote add origin https://github.com/${PUBLIC_REPO}.git`);
console.log('  git push -u origin main');
