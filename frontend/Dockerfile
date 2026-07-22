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
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_SOCKET_URL
ARG NEXT_PUBLIC_APP_NAME
ARG ADMIN_SECRET_PATH
ARG ADMIN_GATEWAY_TOKEN
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}
ENV NEXT_PUBLIC_SOCKET_URL=${NEXT_PUBLIC_SOCKET_URL}
ENV NEXT_PUBLIC_APP_NAME=${NEXT_PUBLIC_APP_NAME}
ENV ADMIN_SECRET_PATH=${ADMIN_SECRET_PATH}
ENV ADMIN_GATEWAY_TOKEN=${ADMIN_GATEWAY_TOKEN}
RUN npm run build

# ── ধাপ ৪: প্রোডাকশন রানার (ছোট ইমেজ, শুধু দরকারি ফাইল) ───────
FROM base AS production
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# নিরাপত্তার জন্য non-root ইউজার তৈরি
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
# Fix permissions: write_file() creates 0600 files; non-root nextjs can't read them.
RUN chmod -R a+rX /app/public
# P3-3a: switched from `output: 'standalone'` to default output
# (see next.config.js comment). The standalone COPY below is now
# replaced by copying the whole .next + node_modules + public.
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# P3-3a: was `node server.js` for standalone build. Now we run the
# default Next.js production server (no standalone). next start serves
# the .next output directly from /app.
CMD ["npx", "next", "start"]
