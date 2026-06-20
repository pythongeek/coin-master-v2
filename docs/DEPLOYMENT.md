# 🚀 প্রোডাকশন ডেপ্লয়মেন্ট গাইড (Ubuntu VPS)

এই গাইড আপনাকে ধাপে ধাপে দেখাবে কীভাবে CryptoFlip একটি Ubuntu VPS-এ লাইভ করবেন।

## প্রয়োজনীয় জিনিস

- একটি Ubuntu 22.04+ VPS (DigitalOcean, Linode, Vultr, বা যেকোনো প্রোভাইডার থেকে)
- একটি ডোমেইন নাম (e.g. cryptoflip.com)
- ন্যূনতম স্পেসিফিকেশন: 2 vCPU, 4GB RAM, 50GB SSD

## ধাপ ১: VPS-এ SSH করুন

```bash
ssh root@your-server-ip
```

## ধাপ ২: সার্ভার স্বয়ংক্রিয় সেটআপ করুন

প্রথমে রিপো ক্লোন করুন:

```bash
mkdir -p /opt/cryptoflip
cd /opt/cryptoflip
git clone https://github.com/your-username/cryptoflip.git .
```

স্বয়ংক্রিয় সেটআপ স্ক্রিপ্ট চালান (Docker, ফায়ারওয়াল, ইত্যাদি সব ইন্সটল করবে):

```bash
chmod +x scripts/setup-server.sh
sudo ./scripts/setup-server.sh
```

## ধাপ ৩: এনভায়রনমেন্ট ভেরিয়েবল সেট করুন

```bash
cp .env.example .env
nano .env
```

**গুরুত্বপূর্ণ পরিবর্তন:**
- `POSTGRES_PASSWORD` — শক্তিশালী পাসওয়ার্ড দিন
- `REDIS_PASSWORD` — শক্তিশালী পাসওয়ার্ড দিন
- `JWT_SECRET` — দীর্ঘ র‍্যান্ডম স্ট্রিং দিন (নিচের কমান্ড দিয়ে জেনারেট করুন)
- `NEXT_PUBLIC_API_URL` — আপনার ডোমেইন দিয়ে আপডেট করুন (e.g. `https://cryptoflip.com`)

র‍্যান্ডম সিক্রেট জেনারেট করতে:
```bash
openssl rand -base64 32
```

## ধাপ ৪: ডোমেইন DNS সেটআপ করুন

আপনার ডোমেইন রেজিস্ট্রারে গিয়ে A রেকর্ড যোগ করুন:

| টাইপ | নাম | মান |
|------|-----|------|
| A | @ | আপনার VPS IP |
| A | www | আপনার VPS IP |

(Cloudflare ব্যবহার করতে চাইলে `docs/CLOUDFLARE_SETUP.md` দেখুন — এটি অতিরিক্ত DDoS সুরক্ষা দেয়)

DNS প্রোপাগেট হতে কিছুক্ষণ সময় লাগতে পারে। চেক করুন:
```bash
nslookup yourdomain.com
```

## ধাপ ৫: SSL সার্টিফিকেট সেটআপ করুন

```bash
chmod +x scripts/setup-ssl.sh
./scripts/setup-ssl.sh yourdomain.com your@email.com
```

## ধাপ ৬: পুরো সিস্টেম চালু করুন

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

প্রথমবার বিল্ড হতে ৫-১০ মিনিট সময় লাগতে পারে।

## ধাপ ৭: যাচাই করুন

```bash
# সব কন্টেইনার চালু আছে কিনা চেক করুন
docker compose -f docker-compose.prod.yml ps

# লগ দেখুন
docker compose -f docker-compose.prod.yml logs -f

# স্বাস্থ্য পরীক্ষা
curl https://yourdomain.com/health
```

ব্রাউজারে `https://yourdomain.com` খুলুন — গেমটি লাইভ দেখতে পাবেন!

## প্রথম এডমিন অ্যাকাউন্ট তৈরি করুন

ডাটাবেসে সরাসরি কানেক্ট করে নিজের অ্যাকাউন্টকে এডমিন বানান:

```bash
docker compose -f docker-compose.prod.yml exec postgres psql -U cryptoflip_user -d cryptoflip_db
```

তারপর SQL চালান (আগে সাইটে রেজিস্ট্রেশন করে নিন):

```sql
UPDATE users SET is_admin = true WHERE username = 'আপনার_ইউজারনেম';
```

## ভবিষ্যতে কোড আপডেট করতে

কোড পরিবর্তন করার পর প্রতিবার:

```bash
cd /opt/cryptoflip
./scripts/deploy.sh
```

এই স্ক্রিপ্ট স্বয়ংক্রিয়ভাবে: ব্যাকআপ নেয় → নতুন কোড টানে → রিবিল্ড করে → রিস্টার্ট করে।

## ডাটাবেস ব্যাকআপ (নিয়মিত)

cron job সেট করুন প্রতিদিন স্বয়ংক্রিয় ব্যাকআপের জন্য:

```bash
crontab -e
```

এই লাইন যোগ করুন (প্রতিদিন রাত ২টায় ব্যাকআপ):

```
0 2 * * * cd /opt/cryptoflip && docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U cryptoflip_user cryptoflip_db > backups/auto_$(date +\%Y\%m\%d).sql
```

## সমস্যা সমাধান

**কন্টেইনার চালু হচ্ছে না?**
```bash
docker compose -f docker-compose.prod.yml logs backend
docker compose -f docker-compose.prod.yml logs frontend
```

**SSL সার্টিফিকেট কাজ করছে না?**
- নিশ্চিত করুন DNS সঠিকভাবে পয়েন্ট করা আছে
- পোর্ট ৮০ ও ৪৪৩ ফায়ারওয়ালে খোলা আছে কিনা চেক করুন: `ufw status`

**ডাটাবেস কানেক্ট হচ্ছে না?**
- `.env` ফাইলে `DATABASE_URL` সঠিক কিনা চেক করুন
- `docker compose -f docker-compose.prod.yml restart postgres` চালান
