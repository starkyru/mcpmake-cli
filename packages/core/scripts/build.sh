#!/usr/bin/env bash
set -euo pipefail

# Build @mcpmake/core: compile TypeScript, then copy the Handlebars template
# families that tsc does not compile into dist (the emitter loads these at
# runtime). Staged into a temp dir and promoted with a single atomic rename so
# an interrupted build never replaces a known-good dist.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

stage=""
cleanup() {
  if [ -n "$stage" ]; then
    rm -rf "$stage"
  fi
}
trap cleanup EXIT INT TERM

# Stage under the package root so the final promote rename is on the same
# filesystem (and therefore atomic).
stage="$(mktemp -d "$root/.dist-stage.XXXXXX")"

# Compile into the staging dir.
npx tsc -p tsconfig.json --outDir "$stage"

# Copy runtime asset families that tsc does not compile. Destinations mirror the
# source layout under src/emitter so the runtime template loaders resolve them.
cp -r src/emitter/templates "$stage/emitter/templates"
cp -r src/emitter/site-templates "$stage/emitter/site-templates"
cp -r src/emitter/python-templates "$stage/emitter/python-templates"
cp -r src/emitter/worker-templates "$stage/emitter/worker-templates"

# Promote: drop the old dist and atomically rename the finished staging dir.
rm -rf dist
mv "$stage" dist
stage="" # promoted — nothing left to clean up
