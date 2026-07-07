# ═══════════════════════════════════════════════════════════════
#  FRONTEND DOCKERFILE — Next.js প্রোডাকশন বিল্ড
# ═══════════════════════════════════════════════════════════════
#  Multi-stage build — ছোট ও নিরাপদ ইমেজের জন্য

FROM node:20-alpine AS base

WORKDIR /app

# ── ধাপ ১: Dependencies ইন্সটল ────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install --include=dev

# ── ধাপ ৩: প্রোডাকশন বিল্ড ─────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
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

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
