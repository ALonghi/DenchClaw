# Releasing

`package.json` is the release source of truth for `denchclaw`.

## Main flow

1. Bump the root package version in `package.json`.
2. Push or merge that commit to `main`.
3. GitHub Actions runs `.github/workflows/release.yml`.
4. If `v<version>` does not already exist, the workflow creates a matching GitHub release named `v<version>`.

If the GitHub release already exists, the workflow skips creating it. This makes reruns safe.

## Notes

- The GitHub release workflow does not publish to npm or any other external registry.
- No release-specific GitHub secrets are required for the workflow beyond the default `GITHUB_TOKEN`.
- Legacy npm publish and secret-sync helper scripts were removed from this fork to avoid accidental public release automation.
