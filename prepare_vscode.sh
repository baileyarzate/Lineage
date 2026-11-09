#!/usr/bin/env bash
# shellcheck disable=SC1091,2154

set -e

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  cp -rp src/insider/* vscode/
else
  cp -rp src/stable/* vscode/
fi

cp -f LICENSE vscode/LICENSE.txt

# Lineage: ship the recorder as a built-in extension (always installed, can't be uninstalled).
./lineage/bundle-recorder.sh vscode/extensions

cd vscode || { echo "'vscode' dir not found"; exit 1; }

{ set +x; } 2>/dev/null

# include common functions (also provides APP_NAME, BINARY_NAME, GH_REPO_PATH, ...)
. ../utils.sh

# {{{ product.json
cp product.json{,.bak}

setpath() {
  local jsonTmp
  { set +x; } 2>/dev/null
  jsonTmp=$( jq --arg 'value' "${3}" "setpath(path(.${2}); \$value)" "${1}.json" )
  echo "${jsonTmp}" > "${1}.json"
  set -x
}

setpath_json() {
  local jsonTmp
  { set +x; } 2>/dev/null
  jsonTmp=$( jq --argjson 'value' "${3}" "setpath(path(.${2}); \$value)" "${1}.json" )
  echo "${jsonTmp}" > "${1}.json"
  set -x
}

setpath "product" "checksumFailMoreInfoUrl" "https://go.microsoft.com/fwlink/?LinkId=828886"
setpath "product" "documentationUrl" "https://go.microsoft.com/fwlink/?LinkID=533484#vscode"
setpath_json "product" "extensionsGallery" '{"serviceUrl": "https://open-vsx.org/vscode/gallery", "itemUrl": "https://open-vsx.org/vscode/item", "latestUrlTemplate": "https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest", "controlUrl": "https://raw.githubusercontent.com/EclipseFdn/publish-extensions/refs/heads/master/extension-control/extensions.json"}'

setpath "product" "introductoryVideosUrl" "https://go.microsoft.com/fwlink/?linkid=832146"
setpath "product" "keyboardShortcutsUrlLinux" "https://go.microsoft.com/fwlink/?linkid=832144"
setpath "product" "keyboardShortcutsUrlMac" "https://go.microsoft.com/fwlink/?linkid=832143"
setpath "product" "keyboardShortcutsUrlWin" "https://go.microsoft.com/fwlink/?linkid=832145"
setpath "product" "licenseUrl" "https://github.com/${GH_REPO_PATH}/blob/HEAD/LICENSE"
setpath_json "product" "linkProtectionTrustedDomains" '["https://open-vsx.org"]'
setpath "product" "releaseNotesUrl" "https://go.microsoft.com/fwlink/?LinkID=533483#vscode"
setpath "product" "reportIssueUrl" "https://github.com/${GH_REPO_PATH}/issues/new"
setpath "product" "requestFeatureUrl" "https://go.microsoft.com/fwlink/?LinkID=533482"
setpath "product" "tipsAndTricksUrl" "https://go.microsoft.com/fwlink/?linkid=852118"
setpath "product" "twitterUrl" "https://go.microsoft.com/fwlink/?LinkID=533687"

if [[ "${DISABLE_UPDATE}" != "yes" ]]; then
  setpath "product" "updateUrl" "https://raw.githubusercontent.com/${VERSIONS_REPOSITORY}/refs/heads/master"
  setpath "product" "downloadUrl" "https://github.com/${ASSETS_REPOSITORY}/releases"
fi

# if [[ "${OS_NAME}" == "windows" ]]; then
#   setpath_json "product" "win32VersionedUpdate" "true"
# fi

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  setpath "product" "nameShort" "${APP_NAME} - Insiders"
  setpath "product" "nameLong" "${APP_NAME} - Insiders"
  setpath "product" "applicationName" "${BINARY_NAME}"
  setpath "product" "dataFolderName" ".${APP_NAME_LC}-insiders"
  setpath "product" "linuxIconName" "${APP_NAME_LC}-insiders"
  setpath "product" "quality" "insider"
  setpath "product" "urlProtocol" "${APP_NAME_LC}-insiders"
  setpath "product" "serverApplicationName" "${BINARY_NAME}-server"
  setpath "product" "serverDataFolderName" ".${APP_NAME_LC}-server-insiders"
  setpath "product" "darwinBundleIdentifier" "com.${APP_NAME_LC}.${APP_NAME}Insiders"
  setpath "product" "win32AppUserModelId" "${APP_NAME}.${APP_NAME}Insiders"
  setpath "product" "win32DirName" "${APP_NAME} Insiders"
  setpath "product" "win32MutexName" "${APP_NAME_LC}insiders"
  setpath "product" "win32NameVersion" "${APP_NAME} Insiders"
  setpath "product" "win32RegValueName" "${APP_NAME}Insiders"
  setpath "product" "win32ShellNameShort" "${APP_NAME} Insiders"
  # Windows GUIDs are unique to Lineage so it never collides with a VSCodium install
  setpath "product" "win32AppId" "{{38AC968E-451C-4135-9933-E7FC71BE181A}"
  setpath "product" "win32x64AppId" "{{A4B9F1D4-AA13-4FCA-B0DC-61602D621518}"
  setpath "product" "win32arm64AppId" "{{DAA19666-E2C6-4CFB-BBB8-D270B8C0A41D}"
  setpath "product" "win32UserAppId" "{{6650A0A1-436F-4410-B2CD-623C74FB42A9}"
  setpath "product" "win32x64UserAppId" "{{20A98F7E-ACC2-4A01-A90E-A7DB5286D2FD}"
  setpath "product" "win32arm64UserAppId" "{{F64E8236-D5D2-4561-B8CD-1EF15865AADE}"
  setpath "product" "tunnelApplicationName" "${TUNNEL_APP_NAME}"
  setpath "product" "win32TunnelServiceMutex" "${APP_NAME_LC}insiders-tunnelservice"
  setpath "product" "win32TunnelMutex" "${APP_NAME_LC}insiders-tunnel"
  setpath "product" "win32ContextMenu.x64.clsid" "36CAE248-1B8F-4104-8C08-565D14E6C527"
  setpath "product" "win32ContextMenu.arm64.clsid" "975774C1-6EAA-431F-984C-FB2F5D670AAB"
else
  setpath "product" "nameShort" "${APP_NAME}"
  setpath "product" "nameLong" "${APP_NAME}"
  setpath "product" "applicationName" "${BINARY_NAME}"
  setpath "product" "dataFolderName" ".${APP_NAME_LC}"
  setpath "product" "linuxIconName" "${APP_NAME_LC}"
  setpath "product" "quality" "stable"
  setpath "product" "urlProtocol" "${APP_NAME_LC}"
  setpath "product" "serverApplicationName" "${BINARY_NAME}-server"
  setpath "product" "serverDataFolderName" ".${APP_NAME_LC}-server"
  setpath "product" "darwinBundleIdentifier" "com.${APP_NAME_LC}"
  setpath "product" "win32AppUserModelId" "${APP_NAME}.${APP_NAME}"
  setpath "product" "win32DirName" "${APP_NAME}"
  setpath "product" "win32MutexName" "${APP_NAME_LC}"
  setpath "product" "win32NameVersion" "${APP_NAME}"
  setpath "product" "win32RegValueName" "${APP_NAME}"
  setpath "product" "win32ShellNameShort" "${APP_NAME}"
  # Windows GUIDs are unique to Lineage so it never collides with a VSCodium install
  setpath "product" "win32AppId" "{{B30BDA56-A763-4D6D-9747-69ECB30F6D8D}"
  setpath "product" "win32x64AppId" "{{5D4FF7F4-AFB0-4803-990E-3BC580112FFA}"
  setpath "product" "win32arm64AppId" "{{5FC44273-AFC9-49A5-9365-0E41BCDC8E51}"
  setpath "product" "win32UserAppId" "{{496C63E8-88A2-46F4-8C6A-E69A41EF38E2}"
  setpath "product" "win32x64UserAppId" "{{987A5EF7-8A10-4C3D-944E-F5DD15537405}"
  setpath "product" "win32arm64UserAppId" "{{C772E8EC-F934-4667-871D-2DCAC52044C4}"
  setpath "product" "tunnelApplicationName" "${TUNNEL_APP_NAME}"
  setpath "product" "win32TunnelServiceMutex" "${APP_NAME_LC}-tunnelservice"
  setpath "product" "win32TunnelMutex" "${APP_NAME_LC}-tunnel"
  setpath "product" "win32ContextMenu.x64.clsid" "6A656F56-092E-45AC-A85F-BA75726858D0"
  setpath "product" "win32ContextMenu.arm64.clsid" "8338880B-E255-4F63-B52C-FFF55DEA3713"
fi

setpath_json "product" "tunnelApplicationConfig" '{}'

jsonTmp=$( jq -s '.[0] * .[1]' product.json ../product.json )
echo "${jsonTmp}" > product.json && unset jsonTmp

cat product.json
# }}}

# {{{ apply patches

echo "APP_NAME=\"${APP_NAME}\""
echo "APP_NAME_LC=\"${APP_NAME_LC}\""
echo "ASSETS_REPOSITORY=\"${ASSETS_REPOSITORY}\""
echo "BINARY_NAME=\"${BINARY_NAME}\""
echo "GH_REPO_PATH=\"${GH_REPO_PATH}\""
echo "GLOBAL_DIRNAME=\"${GLOBAL_DIRNAME}\""
echo "ORG_NAME=\"${ORG_NAME}\""
echo "TUNNEL_APP_NAME=\"${TUNNEL_APP_NAME}\""

if [[ "${DISABLE_UPDATE}" == "yes" ]]; then
  apply_patch ../patches/00-update-disable.patch.yet
fi

for file in ../patches/*.json; do
  if [[ -f "${file}" ]]; then
    apply_actions "${file}"
  fi
done

for file in ../patches/*.patch; do
  if [[ -f "${file}" ]]; then
    apply_patch "${file}"
  fi
done

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  for file in ../patches/insider/*.patch; do
    if [[ -f "${file}" ]]; then
      apply_patch "${file}"
    fi
  done
fi

if [[ -d "../patches/${OS_NAME}/" ]]; then
  for file in "../patches/${OS_NAME}/"*.patch; do
    if [[ -f "${file}" ]]; then
      apply_patch "${file}"
    fi
  done
fi

for file in ../patches/user/*.patch; do
  if [[ -f "${file}" ]]; then
    apply_patch "${file}"
  fi
done
# }}}

set -x

# {{{ install dependencies
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

if [[ "${OS_NAME}" == "linux" ]]; then
  export VSCODE_SKIP_NODE_VERSION_CHECK=1

  if [[ "${npm_config_arch}" == "arm" ]]; then
    export npm_config_arm_version=7
  fi
elif [[ "${OS_NAME}" == "windows" ]]; then
  if [[ "${npm_config_arch}" == "arm" ]]; then
    export npm_config_arm_version=7
  fi
else
  if [[ "${CI_BUILD}" != "no" ]]; then
    clang++ --version
  fi
fi

node build/npm/preinstall.ts

for i in {1..5}; do # try 5 times
  if [[ "${CI_BUILD}" != "no" && "${OS_NAME}" == "osx" ]]; then
    CXX=clang++ npm ci && break
  else
    npm ci && break
  fi

  if [[ $i == 5 ]]; then
    echo "Npm install failed too many times" >&2
    exit 1
  fi
  echo "Npm install failed $i, trying again..."

  sleep $(( 15 * (i + 1)))
done
# }}}

# package.json
cp package.json{,.bak}

setpath "package" "version" "${RELEASE_VERSION%-insider}"

replace "s|Microsoft Corporation|${APP_NAME}|" package.json
replace "s|--max-old-space-size=8192|--max-old-space-size=${MAX_OLD_SPACE_SIZE}|" package.json

cp resources/server/manifest.json{,.bak}

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  setpath "resources/server/manifest" "name" "${APP_NAME} - Insiders"
  setpath "resources/server/manifest" "short_name" "${APP_NAME} - Insiders"
else
  setpath "resources/server/manifest" "name" "${APP_NAME}"
  setpath "resources/server/manifest" "short_name" "${APP_NAME}"
fi

# announcements
replace "s|\\[\\/\\* BUILTIN_ANNOUNCEMENTS \\*\\/\\]|$( tr -d '\n' < ../announcements-builtin.json )|" src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.ts

../undo_telemetry.sh

replace "s|Microsoft Corporation|${APP_NAME}|" build/lib/electron.ts
replace "s|([0-9]) Microsoft|\\1 ${APP_NAME}|" build/lib/electron.ts

if [[ "${OS_NAME}" == "linux" ]]; then
  # microsoft adds their apt repo to sources
  # unless the app name is code-oss
  # as we are renaming the application
  # we need to edit a line in the post install template
  sed -i "s/code-oss/${BINARY_NAME}/" resources/linux/debian/postinst.template

  # fix the packages metadata
  # code.appdata.xml
  sed -i "s|Visual Studio Code|${APP_NAME}|g" resources/linux/code.appdata.xml
  sed -i "s|https://code.visualstudio.com/docs/setup/linux|https://github.com/${GH_REPO_PATH}#readme|" resources/linux/code.appdata.xml
  sed -i "s|https://code.visualstudio.com/home/home-screenshot-linux-lg.png|https://github.com/${GH_REPO_PATH}|" resources/linux/code.appdata.xml
  sed -i "s|https://code.visualstudio.com|https://github.com/${GH_REPO_PATH}|" resources/linux/code.appdata.xml

  # control.template
  sed -i "s|Microsoft Corporation <vscode-linux@microsoft.com>|${APP_NAME} Team https://github.com/${GH_REPO_PATH}/graphs/contributors|"  resources/linux/debian/control.template
  sed -i "s|Visual Studio Code|${APP_NAME}|g" resources/linux/debian/control.template
  sed -i "s|https://code.visualstudio.com/docs/setup/linux|https://github.com/${GH_REPO_PATH}#readme|" resources/linux/debian/control.template
  sed -i "s|https://code.visualstudio.com|https://github.com/${GH_REPO_PATH}|" resources/linux/debian/control.template

  # code.spec.template
  sed -i "s|Microsoft Corporation|${APP_NAME} Team|" resources/linux/rpm/code.spec.template
  sed -i "s|Visual Studio Code Team <vscode-linux@microsoft.com>|${APP_NAME} Team https://github.com/${GH_REPO_PATH}/graphs/contributors|" resources/linux/rpm/code.spec.template
  sed -i "s|Visual Studio Code|${APP_NAME}|" resources/linux/rpm/code.spec.template
  sed -i "s|https://code.visualstudio.com/docs/setup/linux|https://github.com/${GH_REPO_PATH}#readme|" resources/linux/rpm/code.spec.template
  sed -i "s|https://code.visualstudio.com|https://github.com/${GH_REPO_PATH}|" resources/linux/rpm/code.spec.template

  # snapcraft.yaml
  sed -i "s|Visual Studio Code|${APP_NAME}|" resources/linux/rpm/code.spec.template
elif [[ "${OS_NAME}" == "windows" ]]; then
  # code.iss
  sed -i "s|https://code.visualstudio.com|https://github.com/${GH_REPO_PATH}|" build/win32/code.iss
  sed -i "s|Microsoft Corporation|${APP_NAME}|" build/win32/code.iss
fi

cd ..
