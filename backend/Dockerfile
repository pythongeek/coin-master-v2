# ═══════════════════════════════════════════════════════════════
#  BACKEND DOCKERFILE — Node.js প্রোডাকশন বিল্ড
# ═══════════════════════════════════════════════════════════════

FROM node:20-alpine AS base
WORKDIR /app

# ── ধাপ ১: Dependencies ───────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install --include=dev

# ── ধাপ ২: ডেভেলপমেন্ট (hot reload) ───────────────────────────
FROM base AS development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 4000
CMD ["npm", "run", "dev"]

# ── ধাপ ৩: TypeScript কম্পাইল ──────────────────────────────────
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

# ── ধাপ ৪: প্রোডাকশন রানার ─────────────────────────────────────
FROM base AS production
ENV NODE_ENV=production

RUN apk add --no-cache openssl

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 backend

# শুধু প্রোডাকশন dependencies ইন্সটল করো
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=builder --chown=backend:nodejs /app/dist ./dist
COPY --chown=backend:nodejs migrations ./migrations
COPY --chown=backend:nodejs prisma ./prisma
COPY --chown=backend:nodejs tesseract-lang ./tesseract-lang
RUN npx prisma generate
RUN mkdir -p /app/logs && chown backend:nodejs /app/logs

USER backend
EXPOSE 4000

# স্বাস্থ্য পরীক্ষা — Docker জানবে সার্ভিস ঠিকমতো চলছে কিনা
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/index.js"]
