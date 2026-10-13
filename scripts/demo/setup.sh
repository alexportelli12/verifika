# Sourced by scene.tape before recording starts: creates the demo repository,
# records one full run (so the skipped check's saved time is known), then edits
# one source file so `vfk` has a change to verify.
set -e
rm -rf /tmp/shop
cp -R /vhs/scripts/demo/fixture /tmp/shop
cd /tmp/shop
# Fixed identity and dates give the same commit hash on every recording.
export GIT_AUTHOR_NAME=demo GIT_AUTHOR_EMAIL=demo@example.com GIT_COMMITTER_NAME=demo GIT_COMMITTER_EMAIL=demo@example.com
export GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z
git init --quiet --initial-branch=main
git add --all
git commit --quiet --message "Initial commit"
vfk --all --mode quiet
printf '\nexport const FREE_SHIPPING_FROM = 50;\n' >> src/cart.ts
set +e
export PS1='\[\e[38;2;126;226;168m\]❯\[\e[0m\] '
clear
