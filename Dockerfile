# syntax=docker/dockerfile:1.7
# spm-dev-agent-cloud — GCE VM (i-β) / Cloud Run 兼用イメージ。
# Web 本体と Claude Code spawn 環境を 1 イメージに同梱する。

FROM node:22-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       openssl ca-certificates git curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- deps: install dependencies (native toolchain for node-pty) ----
FROM base AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ---- builder: prisma generate + next build ----
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

# ---- runner: production image with Claude Code CLI ----
FROM base AS runner
ENV NODE_ENV=production
# Claude Code CLI: spawned per-project by parallel-tick (i-β architecture)
RUN npm install -g @anthropic-ai/claude-code
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/src/generated ./src/generated
EXPOSE 8080
ENV PORT=8080
CMD ["npm", "run", "start"]
