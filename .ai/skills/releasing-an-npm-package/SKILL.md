---
name: releasing-an-npm-package
description: Use when the user explicitly asks to release or publish a version of this npm package. Completing a branch does not authorize a release.
---

# Releasing the npm package

Read `package.json`, `server.json`, and the current GitHub release workflow
before changing metadata. Use the
requested version and preserve the package's supported Node and platform matrix.
Run the canonical completion checks and inspect the package file list before
committing release metadata. Do not publish development tooling, fixtures,
credentials, or local vault content.

Synchronize `package.json`, the lockfile, and `server.json` before tagging. This
repository uses the following sequence after verification:

```bash
npm version X.Y.Z --no-git-tag-version
npm run sync-server-json
git add package.json package-lock.json server.json
git commit -m "chore(release): X.Y.Z"
git push origin master
git tag vX.Y.Z
git push origin vX.Y.Z
```

The tag must name the same commit as the synchronized version files. Push and
publish only within the user's explicit release authorization.

A tag push starts the release workflow. Confirm CI passed on that exact commit,
then check the GitHub release and npm version before reporting publication.
If a workflow fails after a tag or version is public, inspect its failure and
repair that release. Do not blindly rerun a version bump or create another tag.
Describe user-facing changes and compatibility requirements with humanizer.
