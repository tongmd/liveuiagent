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
for item in package.json package-lock.json liveuiagent.config.json tsconfig.json tsconfig.server.json server packages frontend scripts deploy apps .gitmodules vendor/recallos; do
  if [[ -n $(git -C "$repo" ls-tree --name-only "$revision" -- "$item") ]]; then paths+=("$item"); fi
done
((${#paths[@]})) || { echo 'No runtime source found.' >&2; exit 2; }
# git archive omits gitlinks. Export each recorded submodule commit explicitly;
# neither a branch tip nor untracked local files belong in a release image.
python3 - "$repo" "$revision" "$archive" "${paths[@]}" <<'PY'
import gzip
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile

repo, revision, output, *paths = sys.argv[1:]
output = pathlib.Path(output).resolve()

try:
    with tempfile.TemporaryDirectory() as directory:
        parts = []

        def collect(root, commit, prefix, selected):
            part = pathlib.Path(directory) / (str(len(parts)) + '.tar')
            subprocess.run(['git', '-C', str(root), 'archive', '--format=tar',
                            '--prefix=' + prefix, '--output=' + str(part), commit,
                            '--', *selected], check=True)
            parts.append(part)
            tree = subprocess.check_output(['git', '-C', str(root), 'ls-tree',
                                            '-rz', commit, '--', *selected])
            for entry in tree.split(b'\0'):
                if not entry:
                    continue
                metadata, name = entry.split(b'\t', 1)
                mode, kind, pinned = metadata.decode().split()
                if mode != '160000':
                    continue
                name = os.fsdecode(name)
                child = root / name
                if not (child / '.git').exists():
                    raise ValueError('Initialize pinned dependencies first: '
                                     'git submodule update --init --recursive')
                collect(child, pinned, prefix + name + '/', [])

        collect(pathlib.Path(repo).resolve(), revision, '', paths)
        with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as staged:
            staged_path = pathlib.Path(staged.name)
            try:
                with gzip.GzipFile(fileobj=staged, mode='wb', filename='', mtime=0) as compressed:
                    with tarfile.open(fileobj=compressed, mode='w|') as target:
                        for part in parts:
                            with tarfile.open(part) as source:
                                for member in source:
                                    target.addfile(member, source.extractfile(member)
                                                   if member.isfile() else None)
                staged.close()
                staged_path.replace(output)
            finally:
                staged_path.unlink(missing_ok=True)
except (OSError, ValueError, subprocess.CalledProcessError, tarfile.TarError) as error:
    print('Cannot archive pinned source: ' + str(error), file=sys.stderr)
    raise SystemExit(2)
PY
printf '%s\n' "$revision"
