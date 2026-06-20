#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  SSL SETUP SCRIPT — বিনামূল্যে SSL সার্টিফিকেট (Let's Encrypt)
# ═══════════════════════════════════════════════════════════════
#  HTTPS চালু করার জন্য এই স্ক্রিপ্টটি একবার চালান।
#
#  ব্যবহারের আগে:
#  ১. আপনার ডোমেইনের DNS A রেকর্ড এই সার্ভারের IP-তে পয়েন্ট করুন
#  ২. nginx/nginx.prod.conf ফাইলে yourdomain.com পরিবর্তন করুন
#
#  ব্যবহার:
#    chmod +x scripts/setup-ssl.sh
#    ./scripts/setup-ssl.sh yourdomain.com your@email.com
# ═══════════════════════════════════════════════════════════════

set -e

DOMAIN=$1
EMAIL=$2

if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
  echo "❌ ব্যবহার: ./scripts/setup-ssl.sh yourdomain.com your@email.com"
  exit 1
fi

echo "═══════════════════════════════════════════════"
echo "  🔒 SSL সার্টিফিকেট সেটআপ — $DOMAIN"
echo "═══════════════════════════════════════════════"

# ── ধাপ ১: nginx config-এ ডোমেইন বসাও ──────────────────────────
echo ""
echo "📝 ধাপ ১/৩: Nginx কনফিগে ডোমেইন বসানো হচ্ছে..."
sed -i "s/yourdomain.com/$DOMAIN/g" nginx/nginx.prod.conf
echo "✅ ডোমেইন আপডেট হয়েছে: $DOMAIN"

# ── ধাপ ২: প্রথমে Nginx শুধু HTTP দিয়ে চালু করো (ভেরিফিকেশনের জন্য) ──
echo ""
echo "🌐 ধাপ ২/৩: অস্থায়ী HTTP সার্ভার চালু হচ্ছে..."
mkdir -p nginx/ssl
docker compose -f docker-compose.prod.yml up -d nginx

# ── ধাপ ৩: Certbot দিয়ে সার্টিফিকেট নাও ────────────────────────
echo ""
echo "🔐 ধাপ ৩/৩: Let's Encrypt থেকে সার্টিফিকেট আনা হচ্ছে..."
docker run --rm \
  -v "$(pwd)/nginx/ssl:/etc/letsencrypt" \
  -v "$(pwd)/nginx/certbot_webroot:/var/www/certbot" \
  certbot/certbot certonly \
  --webroot --webroot-path=/var/www/certbot \
  --email "$EMAIL" --agree-tos --no-eff-email \
  -d "$DOMAIN" -d "www.$DOMAIN"

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✅ SSL সার্টিফিকেট সফলভাবে তৈরি হয়েছে!"
echo "═══════════════════════════════════════════════"
echo ""
echo "এখন সম্পূর্ণ সিস্টেম রিস্টার্ট করুন HTTPS চালু করতে:"
echo "  docker compose -f docker-compose.prod.yml restart nginx"
echo ""
echo "সার্টিফিকেট স্বয়ংক্রিয়ভাবে প্রতি ৬০ দিনে রিনিউ হবে।"
echo ""
