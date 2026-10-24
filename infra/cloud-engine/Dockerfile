# CoGolfer cloud engine: OBS Studio (official PPA build, includes Browser Source for
# graphics) on a virtual display, driven by the CoGolfer agent. One container per live
# tournament, started and stopped by the server (CLOUD_ENGINE_DRIVER=docker).
#
# Build from the repository root:
#   docker build -f infra/cloud-engine/Dockerfile -t cogolfer/cloud-engine:latest .

FROM node:22-bookworm-slim AS agent
WORKDIR /opt/agent
COPY agent/package.json agent/package-lock.json ./
RUN npm ci
COPY agent/tsconfig.json ./
COPY agent/src ./src
RUN npm run build && npm prune --omit=dev

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends software-properties-common gpg-agent ca-certificates \
 && add-apt-repository -y ppa:obsproject/obs-studio \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      obs-studio xvfb xauth dbus-x11 libgl1-mesa-dri \
      fonts-dejavu-core fonts-noto-core \
 && apt-get purge -y software-properties-common gpg-agent && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY --from=agent /usr/local/bin/node /usr/local/bin/node
COPY --from=agent /opt/agent /opt/agent
COPY infra/cloud-engine/entrypoint.sh /usr/local/bin/cloud-engine
RUN chmod +x /usr/local/bin/cloud-engine && useradd -m -u 1001 obs
USER obs
WORKDIR /home/obs
ENTRYPOINT ["/usr/local/bin/cloud-engine"]
