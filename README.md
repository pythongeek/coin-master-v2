# 🪙 CryptoFlip — Provably Fair Crypto Coin Flip Game

> বাংলাদেশের প্রথম সামাজিক, Provably Fair ক্রিপ্টো কয়েন ফ্লিপ গেম — Squad Flip ও Live Crypto Rain ফিচার সহ।

![Node](https://img.shields.io/badge/Node.js-20.x-339933?logo=node.js&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)

---

## ✨ ফিচার সমূহ

| ফিচার | বর্ণনা |
|---|---|
| 🪙 **3D Coin Flip** | React Three Fiber দিয়ে তৈরি বাস্তবসম্মত থ্রিডি কয়েন অ্যানিমেশন |
| 🔐 **Provably Fair** | SHA-256 / HMAC ভিত্তিক — ইউজার নিজেই প্রতিটি গেম যাচাই করতে পারে |
| 👥 **Squad Flip** | বন্ধুরা মিলে পুল বেট করে একসাথে জেতার ইউনিক ফিচার |
| 🌧️ **Crypto Rain** | Win streak-এ লাইভ চ্যাটে ফ্রি ক্রিপ্টো বর্ষণ — Retention বুস্টার |
| 💬 **Live Chat** | Socket.io চালিত রিয়েল-টাইম চ্যাট ও নোটিফিকেশন |
| 🦊 **Web3 Wallet** | MetaMask ও Phantom ওয়ালেট কানেক্ট সাপোর্ট |
| ⚙️ **Admin Panel** | হাউজ এজ, বেট লিমিট, রেইন বাজেট — সব লাইভ কনফিগারেবল |
| 📊 **Dashboard** | ইউজার P&L চার্ট, বেট হিস্ট্রি, ভেরিফিকেশন টুল |

## 🛠️ Tech Stack

| লেয়ার | টেকনোলজি |
|---|---|
| Frontend | Next.js 14 (App Router), TypeScript, Tailwind CSS, Zustand |
| 3D / Visual | React Three Fiber (Three.js), Framer Motion |
| Backend | Node.js, Express, Socket.io |
| Database | PostgreSQL 16, Redis 7 |
| Auth | JWT, bcrypt, Web3 Signature Verification |
| Infra | Docker, Docker Compose, Nginx, Let's Encrypt SSL |

## 📁 প্রজেক্ট স্ট্রাকচার

```
crypto-coin-flip/
├── frontend/                  Next.js + Three.js অ্যাপ
│   ├── app/                   game/, dashboard/, admin/ পেজ
│   ├── components/            game/, dashboard/, layout/ কম্পোনেন্ট
│   └── lib/                   socket, store (Zustand), wallet utils
│
├── backend/                   Node.js + Express + Socket.io
│   └── src/
│       ├── routes/            auth, game, admin, dashboard API
│       ├── services/          provably-fair, game-engine, socket-manager
│       ├── middleware/        JWT auth
│       └── db/                PostgreSQL schema
│
├── nginx/                     রিভার্স প্রক্সি (dev + prod SSL কনফিগ)
├── scripts/                   সার্ভার সেটআপ, ডেপ্লয়, SSL স্ক্রিপ্ট
├── docs/                      ডেপ্লয়মেন্ট, Cloudflare, GitHub গাইড
├── docker-compose.yml         ডেভেলপমেন্ট
└── docker-compose.prod.yml    প্রোডাকশন (SSL, রিসোর্স লিমিট সহ)
```

## 🚀 লোকাল ডেভেলপমেন্ট শুরু করুন

### প্রয়োজনীয় সফটওয়্যার

- [Node.js 20 LTS](https://nodejs.org)
- [Docker Desktop](https://www.docker.com/products/docker-desktop)
- [Git](https://git-scm.com)

```bash
node --version    # v20.x.x
docker --version
```

### সেটআপ

```bash
# রিপো ক্লোন করুন
git clone https://github.com/your-username/cryptoflip.git
cd cryptoflip

# এনভায়রনমেন্ট ভেরিয়েবল
cp .env.example .env

# Docker দিয়ে সব সার্ভিস একসাথে চালু করুন
docker-compose up --build
```

ব্রাউজারে খুলুন:
- 🎮 গেম: http://localhost:3000/game
- 📊 ড্যাশবোর্ড: http://localhost:3000/dashboard
- ⚙️ এডমিন: http://localhost:3000/admin
- 🗄️ DB Admin (pgAdmin): http://localhost:5050

### Docker ছাড়া আলাদাভাবে চালাতে চাইলে

```bash
# Terminal 1
cd frontend && npm install && npm run dev

# Terminal 2
cd backend && npm install && npm run dev
```

## 🌐 প্রোডাকশন ডেপ্লয়মেন্ট

সম্পূর্ণ ধাপে ধাপে গাইড: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)

সংক্ষেপে:
```bash
sudo ./scripts/setup-server.sh        # Docker, ফায়ারওয়াল সেটআপ
./scripts/setup-ssl.sh yourdomain.com you@email.com   # বিনামূল্যে SSL
docker compose -f docker-compose.prod.yml up -d --build
```

Cloudflare দিয়ে DDoS প্রোটেকশন: [`docs/CLOUDFLARE_SETUP.md`](docs/CLOUDFLARE_SETUP.md)

## 📤 GitHub-এ প্রথমবার আপলোড করতে

ধাপে ধাপে নির্দেশনা: [`docs/GITHUB_SETUP.md`](docs/GITHUB_SETUP.md)

## 🔐 Provably Fair — কীভাবে কাজ করে

```
HMAC-SHA256(serverSeed, clientSeed + ":" + nonce)
→ প্রথম ৪ বাইট → সংখ্যায় রূপান্তর
→ জোড় সংখ্যা = HEADS | বেজোড় সংখ্যা = TAILS
```

গেমের আগে সার্ভার সিডের হ্যাশ দেওয়া হয় (প্রতিশ্রুতি), গেম শেষে আসল সিড প্রকাশ হয় — ইউজার নিজেই `/game` পেজের ভেরিফিকেশন টুল দিয়ে মিলিয়ে দেখতে পারে কোনো কারচুপি হয়নি।

## 📄 ডকুমেন্টেশন

| ডকুমেন্ট | বিষয় |
|---|---|
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Ubuntu VPS-এ সম্পূর্ণ ডেপ্লয়মেন্ট গাইড |
| [`docs/CLOUDFLARE_SETUP.md`](docs/CLOUDFLARE_SETUP.md) | DDoS প্রোটেকশন সেটআপ |
| [`docs/GITHUB_SETUP.md`](docs/GITHUB_SETUP.md) | GitHub-এ আপলোডের ধাপ |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | অবদান রাখার নিয়মাবলী |
| [`SECURITY.md`](SECURITY.md) | নিরাপত্তা নীতি |

## 📜 লাইসেন্স

[MIT License](LICENSE) — স্বাধীনভাবে ব্যবহার, পরিবর্তন ও বিতরণ করুন।

---

<p align="center">তৈরি হয়েছে ❤️ দিয়ে বাংলাদেশের ক্রিপ্টো গেমিং কমিউনিটির জন্য</p>
