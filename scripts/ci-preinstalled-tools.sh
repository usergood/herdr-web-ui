#!/usr/bin/env bash
# Self-hosted jobs use the immutable runner image, never a download fallback.
set -euo pipefail

fail() {
  echo "::error::$* Rebuild scripts/self-hosted-runner/Dockerfile before retrying." >&2
  exit 1
}

[[ "${RUNNER_OS:-}" == Linux && "${RUNNER_ARCH:-}" == X64 ]] ||
  fail "The prepared CI image requires Linux x64."
: "${EXPECTED_BUN_VERSION:?EXPECTED_BUN_VERSION is required}"

[[ "$(bun --version)" == "$EXPECTED_BUN_VERSION" ]] ||
  fail "The runner image must provide Bun $EXPECTED_BUN_VERSION."

if [[ "${NEED_NODE:-false}" == true ]]; then
  [[ "$(node --version)" == v22.* ]] ||
    fail "The runner image must provide Node 22."
fi

if [[ "${NEED_HERDR:-false}" == true ]]; then
  herdr_path="$(command -v herdr)" || fail "The runner image must provide herdr 0.9.5."
  echo "14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d  $herdr_path" |
    sha256sum --check --status || fail "The runner image must provide the checksum-pinned herdr 0.9.5."
fi

echo "Using verified tools from the self-hosted runner image"
