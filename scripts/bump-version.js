/**
 * Bumps the patch version across the workspace in lockstep.
 *
 * Every package moves together deliberately. The CLI reports its own
 * package.json version as *the* version of the tool, and the About page shows
 * that same number, so a workspace where core and cli disagree would leave a
 * user reading a version that identifies nothing.
 *
 * Prints the new version to stdout so the release workflow can consume it.
 * Writes nothing else there — anything explanatory goes to stderr.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MANIFESTS = [
  'package.json',
  join('packages', 'core', 'package.json'),
  join('packages', 'cli', 'package.json'),
  join('packages', 'web', 'package.json'),
];

function fail(message) {
  process.stderr.write(`[version] ${message}\n`);
  process.exit(1);
}

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) fail(`"${version}" is not a plain major.minor.patch version.`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const release = process.argv[2] ?? 'patch';
if (!['major', 'minor', 'patch'].includes(release)) {
  fail(`Expected major, minor, or patch; got "${release}".`);
}

const rootManifestPath = resolve(root, 'package.json');
const [major, minor, patch] = parse(JSON.parse(readFileSync(rootManifestPath, 'utf8')).version);

const next =
  release === 'major'
    ? `${major + 1}.0.0`
    : release === 'minor'
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;

for (const relativePath of MANIFESTS) {
  const path = resolve(root, relativePath);
  const raw = readFileSync(path, 'utf8');

  // Rewritten with a targeted replacement rather than JSON.stringify so key
  // order, indentation, and the trailing newline survive untouched — a
  // reformatted package.json would fail the repo's own format check.
  const updated = raw.replace(/^(\s*"version"\s*:\s*)"[^"]*"/m, `$1"${next}"`);
  if (updated === raw) fail(`No version field was replaced in ${relativePath}.`);

  writeFileSync(path, updated);
  process.stderr.write(`[version] ${relativePath} -> ${next}\n`);
}

process.stdout.write(`${next}\n`);
