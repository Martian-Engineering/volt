#!/bin/bash
# Rebuild the git repo from scratch with clean opencode lineage
set -euo pipefail

cd /Users/ted/me/volt

# Save current files
TMPDIR=$(mktemp -d)
echo "Saving current files to $TMPDIR..."

# Copy everything except .git and node_modules
rsync -a --exclude='.git' --exclude='node_modules' . "$TMPDIR/"

# Nuke the old repo and start fresh
rm -rf .git
git init -b dev

# Add upstream and fetch full history
git remote add upstream https://github.com/anomalyco/opencode.git
echo "Fetching upstream opencode history (this may take a minute)..."
git fetch upstream dev

# Create our clean commit on top of upstream/dev
git checkout -f -b dev FETCH_HEAD

# Remove all upstream files, replace with ours
git rm -rf . > /dev/null 2>&1
rsync -a --exclude='.git' --exclude='node_modules' "$TMPDIR/" .
git add -A

git commit -m "$(cat <<'COMMIT'
feat: fork from OpenCode with Lossless Context Management (LCM)

Volt is a fork of OpenCode (https://github.com/anomalyco/opencode)
by Voltropy PBC. It introduces Lossless Context Management, a
deterministic context management architecture for LLM memory.

Key additions:
- LCM engine: hierarchical summary DAG, immutable store, active context assembly
- Three-level summarization escalation with guaranteed convergence
- Operator-level recursion: LLM-Map and Agentic-Map parallel tools
- Large file handling with type-aware exploration summaries
- Task delegation with infinite-recursion guard
- Task tree viewer in TUI

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
COMMIT
)"

# Add our remote
git remote add origin git@github.com:voltropy/volt.git

# Clean up
rm -rf "$TMPDIR"
rm -f rebuild-repo.sh

echo ""
echo "Done. Verify with: git log --oneline | head -5"
echo "Then push with: git push -u origin dev"
