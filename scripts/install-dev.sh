#!/bin/bash
# Like install.sh, but on macOS builds with build:mac:dev: ad-hoc signed instead of
# Developer ID, which skips ~4 minutes of Apple timestamp calls. For your own Mac only:
# macOS asks again for Keychain (safeStorage) and microphone access after every
# install, and the app won't open on another Mac. Release builds use install.sh.
set -e
DEVTOOL_MAC_BUILD=build:mac:dev exec "$(dirname "$0")/install.sh"
