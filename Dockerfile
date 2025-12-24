FROM ghcr.io/astral-sh/uv:python3.11-bookworm-slim

RUN apt-get update \
  && apt-get install -y ca-certificates curl gnupg \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
  && echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' > /etc/apt/sources.list.d/nodesource.list \
  && apt-get update \
  && apt-get install -y nodejs \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /alfred

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist ./dist
COPY schemas ./schemas
COPY conversations-in-blockkit.md ./conversations-in-blockkit.md

ENV NODE_ENV=production
