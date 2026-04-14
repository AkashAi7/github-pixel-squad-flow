---
description: "Use when releasing a new version of Pixel Squad, bumping the version number, updating the changelog, or preparing a build for GitHub publication."
---

# Pixel Squad Release Process

Follow these steps in order. Do not skip or reorder.

## 1. Bump the version
Update `"version"` in `package.json` to the new semver (e.g., `"0.1.17"`).

## 2. Update CHANGELOG.md
Add an entry at the top following the existing format:
```
## [X.X.X] — YYYY-MM-DD
### Fixed / Added / Changed
- <concise bullet describing what changed and why>
```

## 3. Build
```bash
npm run build
```
Must exit with code 0 and no TypeScript errors. Do not proceed if the build fails.

## 4. Commit, tag, push
```bash
git add -A
git commit -m "Release vX.X.X - <short description>"
git tag vX.X.X
git push origin main --tags
```

## Rules
- Never tag before bumping `package.json`.
- Never push without a clean build — dist artifacts are committed and must be up to date.
- Tag format is always `vX.X.X` (lowercase `v`).
- The commit message and tag version must match.
