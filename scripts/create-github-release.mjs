import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const packageJsonPath = path.join(repoRoot, 'package.json');
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const requestedVersion = process.argv[2] ?? packageJson.version;
const assetPathArg = process.argv[3] ?? 'github-pixel-squad-flow.vsix';
const assetPath = path.isAbsolute(assetPathArg) ? assetPathArg : path.join(repoRoot, assetPathArg);
const tag = `v${requestedVersion}`;

if (!existsSync(assetPath)) {
  throw new Error(`Release artifact not found: ${assetPath}`);
}

const changelog = readFileSync(changelogPath, 'utf8');
const escapedVersion = requestedVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sectionPattern = new RegExp(`## \\[${escapedVersion}\\][\\s\\S]*?(?=\\n## \\[|$)`);
const sectionMatch = changelog.match(sectionPattern);

if (!sectionMatch) {
  throw new Error(`Could not find changelog entry for version ${requestedVersion}`);
}

const notes = sectionMatch[0].trim();
execFileSync(
  'gh',
  ['release', 'create', tag, assetPath, '-R', 'AkashAi7/github-pixel-squad-flow', '--title', tag, '--notes', notes],
  { stdio: 'inherit' },
);