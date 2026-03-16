#!/usr/bin/env bash
# AgnX Connector — OpenClaw Plugin Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/agnx-net/agnx-connector/main/install.sh | bash
set -euo pipefail

INSTALL_DIR="${HOME}/.openclaw/extensions/agnx-connector"

echo "📦 Installing AgnX Connector to ${INSTALL_DIR} ..."

mkdir -p "${INSTALL_DIR}"
cd "${INSTALL_DIR}"

# Download and extract the npm package flat (no node_modules nesting)
npm pack @agnx-net/connector --quiet 2>/dev/null
tar xzf agnx-net-connector-*.tgz --strip-components=1
rm -f agnx-net-connector-*.tgz

# Install runtime dependencies only (ws)
npm install --omit=dev --quiet 2>/dev/null

echo ""
echo "✅ AgnX Connector installed successfully!"
echo ""
echo "Next steps:"
echo "  1. Edit ~/.openclaw/openclaw.json to add channels + plugins config"
echo "  2. Set your API token from https://www.agnx.net/dashboard"
echo "  3. Run: openclaw reset"
echo ""
echo "📖 Full guide: https://docs.agnx.net/setup-guide"
