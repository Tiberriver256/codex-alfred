# Release Process

## Versioning
- Use SemVer: `MAJOR.MINOR.PATCH`.
- Patch: fixes and small improvements.
- Minor: new features, compatible changes.
- Major: breaking changes.

## Release Steps
1. Update `package.json` version.
2. Run tests: `node --test --import=tsx`.
3. Update `README.md` if behavior/config changed.
4. Create a git tag: `git tag vX.Y.Z`.
5. Push commits and tags: `git push && git push --tags`.

## Notes
- Keep changes minimal and documented.
- Ensure Docker sandbox behavior matches `spec.md` before cutting a release.
