# syntax=docker/dockerfile:1
#
# Multi-stage build for the Next.js standalone server.
#   deps    → install node_modules from the lockfile only (best layer caching)
#   builder → generate the Prisma client and build the app
#   runner  → minimal runtime: standalone server + system Chromium for Playwright
#
# Playwright browsers are NOT downloaded during the build: the runtime uses
# Alpine's system Chromium (see PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH below), which
# keeps the image several hundred MB smaller.

FROM node:25-alpine AS base

# ─── Dependencies ────────────────────────────────────────────────────────────
FROM base AS deps
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

# `npm ci` runs the postinstall (prisma generate), which needs the schema.
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci

# ─── Build ───────────────────────────────────────────────────────────────────
FROM base AS builder
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# `next build` peaks just under Node's ~2 GB default heap and OOMs
# intermittently. Raise the ceiling for the build stage only — the runtime
# stage below does not inherit this.
ENV NODE_OPTIONS=--max-old-space-size=4096

RUN npx prisma generate && npm run build

# ─── Runtime ─────────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Chromium + fonts for Playwright; openssl for Prisma.
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
      openssl \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# The standalone bundle ships its own trimmed node_modules and server.js.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

# Résumé config: the committed example is the fallback. Mount your real
# config/resume.json over this at run time to use your own details.
COPY --from=builder --chown=nextjs:nodejs /app/config ./config

# Prisma's generated client + query engine.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma

RUN mkdir -p /app/applications /app/logs && chown -R nextjs:nodejs /app/applications /app/logs

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
