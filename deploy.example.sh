#!/usr/bin/env bash
# Example deploy script. Copy this to `deploy.sh` and edit DEST to point
# at your own vault's plugin folder. `deploy.sh` is gitignored so your
# personal path stays local.
#
#     cp deploy.example.sh deploy.sh
#     # edit deploy.sh, replace DEST
#     chmod +x deploy.sh
#     ./deploy.sh

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="/path/to/your/vault/.obsidian/plugins/caretsort"

if [ ! -d "$DEST" ]; then
	echo "Destination not found: $DEST"
	echo "Edit DEST in this script to point at your vault."
	exit 1
fi

for f in main.js manifest.json styles.css; do
	if [ ! -f "$SRC/$f" ]; then
		echo "Missing $f in source. Did you forget to run \`npm run build\`?"
		exit 1
	fi
	cp "$SRC/$f" "$DEST/$f"
	echo "✓ $f"
done

echo "Deployed to $DEST"
echo "Reload Obsidian (Cmd+R) to apply."
