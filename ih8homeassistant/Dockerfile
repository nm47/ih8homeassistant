# Development Dockerfile for ih8homeassistant MQTT-to-Matter bridge
# Source code will be mounted as volumes, this just provides the runtime environment

FROM node:22.13-slim

# Install dependencies needed for building native modules and runtime
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    dnsutils \
    iputils-ping \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Set environment variables
ENV NODE_ENV=development
ENV NODE_OPTIONS="--enable-source-maps"

# Expose Matter port (default 5540)
EXPOSE 5540/tcp
EXPOSE 5540/udp

# mDNS port
EXPOSE 5353/udp

# Default command (can be overridden in docker-compose)
CMD ["npm", "run", "dev"]
