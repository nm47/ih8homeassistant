# Image for the ih8homeassistant MQTT-to-Matter bridge.
#
# Dependencies and compilation happen at build time; startup only executes Node, so Docker's
# SIGTERM reaches the bridge directly instead of a wrapping shell.

FROM node:22.13-slim

WORKDIR /app

# Toolchain for any dependency that needs to build a native module
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

# Separate layer so npm ci is only rerun when the manifest or lockfile changes
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Set after the build: the TypeScript devDependencies are needed above
ENV NODE_ENV=production
ENV NODE_OPTIONS="--enable-source-maps"

CMD ["node", "dist/index.js"]
