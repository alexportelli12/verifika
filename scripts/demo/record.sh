#!/bin/sh
# Records the website's terminal demo with VHS in Docker, using the published
# Verifika release that matches package.json (or the version given):
#   site/media/demo-{wide,narrow}.{webm,mp4}  the recordings
#   site/media/demo-{wide,narrow}.png         posters: the final frame
# Usage: scripts/demo/record.sh [version]
set -eu
cd "$(dirname "$0")/../.."
version="${1:-$(node -p "require('./package.json').version")}"
image="verifika-demo:$version"

docker build --quiet --tag "$image" --build-arg "VERIFIKA_VERSION=$version" scripts/demo
run() {
  docker run --rm --user "$(id -u):$(id -g)" --env HOME=/tmp \
    --volume "$PWD:/vhs" --workdir /vhs "$@"
}
for variant in wide narrow; do
  run "$image" "scripts/demo/$variant.tape"
  # -movflags +faststart lets the browser start playing before the file is loaded.
  run --entrypoint sh "$image" -c "ffmpeg -v error -y -i site/media/demo-$variant.mp4 \
    -c copy -movflags +faststart /tmp/demo.mp4 && mv /tmp/demo.mp4 site/media/demo-$variant.mp4"
  run --entrypoint ffmpeg "$image" -v error -y -sseof -1 -i "site/media/demo-$variant.mp4" \
    -frames:v 1 -update 1 "site/media/demo-$variant.png"
done
