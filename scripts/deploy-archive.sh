#!/usr/bin/env bash
set -euo pipefail
repo=${1:?repository required}
archive=${2:?archive path required}
mode=${3:-committed}
git -C "$repo" diff --quiet || { echo 'Stage or commit tracked source changes before deployment.' >&2; exit 2; }
if [[ $mode == staged ]]; then
  revision=$(git -C "$repo" write-tree)
elif [[ $mode == committed ]]; then
  git -C "$repo" diff --cached --quiet || { echo 'Commit staged changes or explicitly use --staged.' >&2; exit 2; }
  revision=$(git -C "$repo" rev-parse HEAD)
else echo 'Invalid archive mode.' >&2; exit 2; fi
# Runtime source only. Papers, benchmark datasets, raw artifacts and private files
# are intentionally not part of the deployed application image.
paths=()
for item in package.json package-lock.json liveuiagent.config.json tsconfig.json tsconfig.server.json server packages frontend scripts deploy apps; do
  if git -C "$repo" cat-file -e "$revision:$item" 2>/dev/null; then paths+=("$item"); fi
done
((${#paths[@]})) || { echo 'No runtime source found.' >&2; exit 2; }
git -C "$repo" archive --format=tar.gz --output="$archive" "$revision" "${paths[@]}"
printf '%s\n' "$revision"
