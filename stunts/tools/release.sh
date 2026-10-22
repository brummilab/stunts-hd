#!/bin/sh
# One command for a release: the site deployed, the desktop apps built, and a GitHub release with them.
#   sh stunts/tools/release.sh            (from anywhere in the checkout)
# The version is desktop/package.json's; the notes are the changelog's newest entry (stunts/setup.js). Needs wrangler
# (npx) and gh, logged in. Stops at the first step that fails.
set -e
cd "$(git rev-parse --show-toplevel)"
git pull --ff-only
V=$(node -p "require('./desktop/package.json').version")
NOTES=$(python3 - "$V" <<'EOF'
import re, sys, html
s = open('stunts/setup.js').read()
m = re.search(r'<b>v' + re.escape(sys.argv[1]) + r'</b>.*?<ul>(.*?)</ul>', s, re.S)
if not m: sys.exit('no changelog entry for v' + sys.argv[1] + ' in stunts/setup.js')
print('\n'.join('- ' + html.unescape(re.sub(r'<[^>]+>', '', li)).strip() for li in re.findall(r'<li>(.*?)</li>', m.group(1), re.S)))
EOF
)
echo "== Stunts HD v$V"; echo "$NOTES"; echo
echo "== site"
python3 stunts/tools/site.py
npx wrangler pages deploy dist --project-name stunts-recomp
echo "== desktop apps"
(cd desktop && npm install --no-audit --no-fund && npm run dist)
echo "== GitHub release"
git rev-parse -q --verify "refs/tags/v$V" >/dev/null || git tag "v$V"
git push origin "v$V"
gh release create "v$V" desktop/out/*.zip desktop/out/*.tar.gz desktop/out/*.AppImage \
  --repo mr-finster/stunts-hd --title "Stunts HD v$V" --latest --notes "$NOTES"
echo "== done: https://github.com/mr-finster/stunts-hd/releases/tag/v$V"
