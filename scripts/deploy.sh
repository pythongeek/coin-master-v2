#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  DEPLOY SCRIPT — নতুন কোড লাইভ সার্ভারে আপডেট করার স্ক্রিপ্ট
# ═══════════════════════════════════════════════════════════════
#  প্রতিবার কোড পরিবর্তন করার পর এই স্ক্রিপ্টটি চালান।
#
#  ব্যবহার:
#    chmod +x scripts/deploy.sh
#    ./scripts/deploy.sh
# ═══════════════════════════════════════════════════════════════

set -e

echo "═══════════════════════════════════════════════"
echo "  🚀 CryptoFlip — ডেপ্লয়মেন্ট শুরু হচ্ছে"
echo "═══════════════════════════════════════════════"

# ── .env ফাইল আছে কিনা চেক করো ────────────────────────────────
if [ ! -f .env ]; then
  echo "❌ ত্রুটি: .env ফাইল পাওয়া যায়নি!"
  echo "   cp .env.example .env চালিয়ে আগে .env তৈরি করুন।"
  exit 1
fi

# ── ধাপ ১: সর্বশেষ কোড টানো ─────────────────────────────────────
echo ""
echo "📥 ধাপ ১/৫: GitHub থেকে সর্বশেষ কোড টানা হচ্ছে..."
git pull origin main

# ── ধাপ ২: ডাটাবেস ব্যাকআপ (নিরাপত্তার জন্য) ──────────────────
echo ""
echo "💾 ধাপ ২/৫: ডাটাবেস ব্যাকআপ নেওয়া হচ্ছে..."
BACKUP_FILE="backups/backup_$(date +%Y%m%d_%H%M%S).sql"
mkdir -p backups
if docker compose -f docker-compose.prod.yml ps postgres | grep -q "Up"; then
  docker compose -f docker-compose.prod.yml exec -T postgres \
    pg_dump -U "$(grep POSTGRES_USER .env | cut -d '=' -f2)" \
    "$(grep POSTGRES_DB .env | cut -d '=' -f2)" > "$BACKUP_FILE" 2>/dev/null || echo "⚠️  প্রথমবার তাই ব্যাকআপ স্কিপ হলো।"
  echo "✅ ব্যাকআপ সেভ হলো: $BACKUP_FILE"
else
  echo "⚠️  ডাটাবেস এখনো চালু হয়নি, ব্যাকআপ স্কিপ করা হলো।"
fi

# ── ধাপ ৩: নতুন Docker ইমেজ বিল্ড করো ────────────────────────
echo ""
echo "🐳 ধাপ ৩/৫: Docker ইমেজ বিল্ড হচ্ছে (একটু সময় লাগবে)..."
docker compose -f docker-compose.prod.yml build --no-cache

# ── ধাপ ৪: পুরানো কন্টেইনার বন্ধ করে নতুনগুলো চালু করো ─────────
echo ""
echo "🔄 ধাপ ৪/৫: কন্টেইনার রিস্টার্ট হচ্ছে (Zero-downtime)..."
docker compose -f docker-compose.prod.yml up -d --remove-orphans

# ── ধাপ ৫: পুরানো অব্যবহৃত ইমেজ মুছে ফেলো ─────────────────────
echo ""
echo "🧹 ধাপ ৫/৫: পুরানো ইমেজ পরিষ্কার করা হচ্ছে..."
docker image prune -f

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✅ ডেপ্লয়মেন্ট সম্পন্ন!"
echo "═══════════════════════════════════════════════"
echo ""
echo "সার্ভিস স্ট্যাটাস দেখতে:"
echo "  docker compose -f docker-compose.prod.yml ps"
echo ""
echo "লগ দেখতে:"
echo "  docker compose -f docker-compose.prod.yml logs -f"
echo ""
