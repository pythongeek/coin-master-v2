#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  SERVER SETUP SCRIPT — Ubuntu VPS প্রথমবার সেটআপ
# ═══════════════════════════════════════════════════════════════
#  এই স্ক্রিপ্ট একবার চালালে আপনার VPS ডেপ্লয়মেন্টের জন্য
#  সম্পূর্ণ প্রস্তুত হয়ে যাবে।
#
#  ব্যবহার:
#    chmod +x scripts/setup-server.sh
#    sudo ./scripts/setup-server.sh
# ═══════════════════════════════════════════════════════════════

set -e  # কোনো কমান্ড ব্যর্থ হলে স্ক্রিপ্ট থেমে যাবে

echo "═══════════════════════════════════════════════"
echo "  🚀 CryptoFlip — Ubuntu VPS সেটআপ শুরু হচ্ছে"
echo "═══════════════════════════════════════════════"

# ── ধাপ ১: সিস্টেম আপডেট ──────────────────────────────────────
echo ""
echo "📦 ধাপ ১/৬: সিস্টেম প্যাকেজ আপডেট হচ্ছে..."
apt-get update -y
apt-get upgrade -y

# ── ধাপ ২: প্রয়োজনীয় টুলস ইন্সটল ──────────────────────────────
echo ""
echo "🔧 ধাপ ২/৬: প্রয়োজনীয় টুলস ইন্সটল হচ্ছে..."
apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  git \
  ufw \
  fail2ban

# ── ধাপ ৩: Docker ইন্সটল ──────────────────────────────────────
echo ""
echo "🐳 ধাপ ৩/৬: Docker ইন্সটল হচ্ছে..."
if ! command -v docker &> /dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    tee /etc/apt/sources.list.d/docker.list > /dev/null

  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

  echo "✅ Docker সফলভাবে ইন্সটল হয়েছে।"
else
  echo "✅ Docker ইতিমধ্যে ইন্সটল করা আছে।"
fi

# ── ধাপ ৪: ফায়ারওয়াল কনফিগার ───────────────────────────────────
echo ""
echo "🔥 ধাপ ৪/৬: ফায়ারওয়াল (UFW) কনফিগার হচ্ছে..."
ufw allow OpenSSH
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS
ufw --force enable
echo "✅ ফায়ারওয়াল চালু — শুধু SSH, HTTP, HTTPS পোর্ট খোলা।"

# ── ধাপ ৫: Fail2Ban চালু (ব্রুট ফোর্স প্রতিরোধ) ───────────────
echo ""
echo "🛡️  ধাপ ৫/৬: Fail2Ban চালু হচ্ছে..."
systemctl enable fail2ban
systemctl start fail2ban
echo "✅ Fail2Ban সক্রিয় — SSH ব্রুট ফোর্স আক্রমণ থেকে সুরক্ষিত।"

# ── ধাপ ৬: প্রজেক্ট ফোল্ডার তৈরি ─────────────────────────────────
echo ""
echo "📁 ধাপ ৬/৬: প্রজেক্ট ফোল্ডার প্রস্তুত হচ্ছে..."
mkdir -p /opt/cryptoflip
mkdir -p /opt/cryptoflip/backups
echo "✅ /opt/cryptoflip ফোল্ডার তৈরি হয়েছে।"

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✅ সার্ভার সেটআপ সম্পন্ন!"
echo "═══════════════════════════════════════════════"
echo ""
echo "পরবর্তী ধাপ:"
echo "  1. আপনার GitHub রিপো ক্লোন করুন:"
echo "     cd /opt/cryptoflip && git clone <your-repo-url> ."
echo ""
echo "  2. .env ফাইল তৈরি করুন:"
echo "     cp .env.example .env && nano .env"
echo ""
echo "  3. ডোমেইন DNS Cloudflare-এ এই সার্ভারের IP-তে পয়েন্ট করুন।"
echo ""
echo "  4. deploy.sh স্ক্রিপ্ট চালান:"
echo "     ./scripts/deploy.sh"
echo ""
