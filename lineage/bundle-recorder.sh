#!/usr/bin/env bash
# Compiles the Lineage recorder and copies it into an extensions folder as a built-in extension.
#
#   lineage/bundle-recorder.sh vscode/extensions           # during the build (prepare_vscode.sh does this)
#   lineage/bundle-recorder.sh path/to/Lineage.app/Contents/Resources/app/extensions   # patch an existing build
#
# Built-in extensions ship inside the app, start automatically and can't be uninstalled.

set -e

DEST="${1:?usage: bundle-recorder.sh <extensions-folder>}"
HERE="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SRC="${HERE}/recorder"
OUT="${DEST}/lineage-recorder"

pushd "${SRC}" > /dev/null
if [[ ! -d node_modules ]]; then
  npm ci --no-audit --no-fund
fi
rm -rf out
npm run compile --silent
popd > /dev/null

rm -rf "${OUT}"
mkdir -p "${OUT}/out"
cp "${SRC}/package.json" "${OUT}/"
cp "${SRC}"/out/*.js "${OUT}/out/"
cp "${HERE}/../LICENSE" "${OUT}/LICENSE.txt"
# Only what's copied above gets packaged; the build's packager also reads this file.
printf '**/*.map\n**/*.ts\n' > "${OUT}/.vscodeignore"

echo "Bundled Lineage recorder into ${OUT}"
