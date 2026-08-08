FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js README.md LICENSE SECURITY.md CHANGELOG.md server.json glama.json GLAMA.md smithery.yaml ./
RUN chmod +x /app/index.js

ENV NODE_ENV=production \
  UTILITY_GRID_BASE_URL=https://x402.forgemesh.io

USER node

CMD ["node", "index.js"]
