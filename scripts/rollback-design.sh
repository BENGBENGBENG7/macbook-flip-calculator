#!/bin/bash
# Restore the reviewed UI baseline while retaining all current business data.
set -euo pipefail
BASELINE='backup/design-review-20261115-213032'
REPO_DIR="$(git -C "$(dirname -- "$0")" rev-parse --show-toplevel)"
if [[ "${1:-}" != '--apply' ]]; then
  printf 'Usage: bash scripts/rollback-design.sh --apply\nRestores UI/icons from %s. Keeps all JSON data. Does not commit or push.\n' "$BASELINE"
  exit 0
fi
git -C "$REPO_DIR" rev-parse --verify "$BASELINE^{commit}" >/dev/null
FILES=(app.js index.html styles.css logo.svg logo-source.png manifest.webmanifest
  favicon-green.png favicon-macbook.png apple-touch-icon.png apple-touch-icon-green.png
  apple-touch-icon-macbook.png icon-192.png icon-512.png icon-green-192.png icon-green-512.png
  icon-green-maskable-512.png icon-macbook-192.png icon-macbook-512.png icon-macbook-maskable-512.png)
SNAPSHOT_DIR="$REPO_DIR/.design-backups/$(date '+%Y%m%d-%H%M%S')-$$"
mkdir -p "$SNAPSHOT_DIR"
for file in "${FILES[@]}"; do
  cp "$REPO_DIR/$file" "$SNAPSHOT_DIR/$file"
done
for file in listings.json deleted-listings.json user-data.json; do
  /usr/bin/shasum -a 256 "$REPO_DIR/$file" >> "$SNAPSHOT_DIR/data-hashes-before.txt"
done
git -C "$REPO_DIR" restore --source="$BASELINE" --worktree -- "${FILES[@]}"
for file in listings.json deleted-listings.json user-data.json; do
  /usr/bin/shasum -a 256 "$REPO_DIR/$file" >> "$SNAPSHOT_DIR/data-hashes-after.txt"
done
cmp "$SNAPSHOT_DIR/data-hashes-before.txt" "$SNAPSHOT_DIR/data-hashes-after.txt"
printf 'Restored UI from %s; all data files unchanged.\nSaved previous UI to %s\nReview, commit and push separately to publish the rollback.\n' "$BASELINE" "$SNAPSHOT_DIR"
