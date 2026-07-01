# ═══════════════════════════════════════════════════════════════
#  FRONTEND DOCKERFILE — Next.js প্রোডাকশন বিল্ড
# ═══════════════════════════════════════════════════════════════
#  Multi-stage build — ছোট ও নিরাপদ ইমেজের জন্য

FROM node:20-alpine AS base

WORKDIR /app

# ── ধাপ ১: Dependencies ইনস্টল ───────────────────────────────
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

# ── ধাপ ২: ডেভেলপমেন্ট (hot reload সহ) ────────────────────────
FROM base AS development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ── ধাপ ৩: প্রোডাকশন বিল্ড ─────────────────────────────────────
# Build-time env (baked into the JS bundle):
#   NEXT_PUBLIC_*       — inlined into client-side bundles
#   ADMIN_SECRET_PATH   — read by next.config.js rewrites() at build time
#
# Runtime env (read by middleware on every request):
#   ADMIN_GATEWAY_TOKEN — injected via docker-compose `environment:`
#                         block, NOT baked into the image. This means
#                         the image can be shared; the secret lives in
#                         compose env only.
FROM base AS builder
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_SOCKET_URL=http://localhost:4000
ARG ADMIN_SECRET_PATH=*** ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_SOCKET_URL=${NEXT_PUBLIC_SOCKET_URL}
ENV ADMIN_SECRET_PATH=${ADMIN_SECRET_PATH}
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── ধাপ ৪: প্রোডাকশন রানার (ছোট ইমেজ, শুধু দরকারি ফাইল) ───────
FROM base AS production
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# নিরাপত্তার জন্য non-root ইউজার তৈরি
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# ADMIN_GATEWAY_TOKEN is injected at runtime via docker-compose `environment:`.
# The middleware reads `process.env.ADMIN_GATEWAY_TOKEN` on every request,
# so the value must be present when the node process starts.

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]