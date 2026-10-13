# Recording environment for the website's terminal demo: VHS plus Node.js and
# the published Verifika CLI. Built and run by record.sh.
ARG VERIFIKA_VERSION

FROM node:24-bookworm-slim AS cli
ARG VERIFIKA_VERSION
RUN npm install --global --no-fund --no-audit "verifika@${VERIFIKA_VERSION}"

FROM ghcr.io/charmbracelet/vhs:v0.10.0
# The image's apt sources name "stable", which is no longer bookworm; pin them.
RUN sed -i 's/stable/bookworm/g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install --yes --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
COPY --from=cli /usr/local/bin/node /usr/local/bin/node
COPY --from=cli /usr/local/lib/node_modules/verifika /usr/local/lib/node_modules/verifika
RUN ln -s ../lib/node_modules/verifika/dist/cli.js /usr/local/bin/vfk
