# 📤 GitHub-এ আপলোড করার গাইড

আপনার এই প্রজেক্টটি প্রথমবার GitHub-এ আপলোড করার সম্পূর্ণ ধাপে ধাপে নির্দেশনা।

## ধাপ ১: GitHub-এ নতুন রিপোজিটরি তৈরি করুন

1. [github.com/new](https://github.com/new) এ যান
2. Repository name দিন: `cryptoflip` (অথবা আপনার পছন্দ মতো)
3. **Public** বা **Private** বেছে নিন (Private রাখাই ভালো, যেহেতু এটি আর্থিক প্ল্যাটফর্ম)
4. **"Initialize this repository with a README"** এ টিক দেবেন না (আমাদের নিজস্ব README আছে)
5. "Create repository" চাপুন

GitHub আপনাকে একটি URL দেখাবে, যেমন:
```
https://github.com/your-username/cryptoflip.git
```

## ধাপ ২: লোকাল মেশিনে Git ইনিশিয়ালাইজ করুন

প্রজেক্ট ফোল্ডারে গিয়ে টার্মিনাল খুলুন:

```bash
cd crypto-coin-flip

# Git রিপো ইনিশিয়ালাইজ করুন
git init

# আপনার পরিচয় সেট করুন (যদি আগে না করা থাকে)
git config user.name "আপনার নাম"
git config user.email "আপনার@ইমেইল.com"
```

## ধাপ ৩: .env ফাইল নিরাপদ আছে কিনা যাচাই করুন

**অত্যন্ত গুরুত্বপূর্ণ** — নিশ্চিত করুন `.env` ফাইল (যদি তৈরি করে থাকেন) গিট-এ যুক্ত হচ্ছে না:

```bash
# এই কমান্ড চালিয়ে দেখুন .env ফাইল তালিকায় আছে কিনা
git status
```

যদি `.env` দেখতে পান, থেমে যান এবং নিশ্চিত করুন `.gitignore` ফাইল ঠিকমতো আছে (এই প্রজেক্টে আগে থেকেই সেটআপ করা আছে)।

## ধাপ ৪: সব ফাইল যোগ করুন ও প্রথম কমিট করুন

```bash
# সব ফাইল স্টেজ করুন (gitignore অনুযায়ী .env বাদ পড়বে)
git add .

# কী যোগ হচ্ছে তা একবার দেখে নিন
git status

# প্রথম কমিট করুন
git commit -m "প্রাথমিক কমিট: CryptoFlip — সম্পূর্ণ প্রজেক্ট স্ট্রাকচার"
```

## ধাপ ৫: GitHub রিপোর সাথে কানেক্ট করুন

```bash
git remote add origin https://github.com/your-username/cryptoflip.git
git branch -M main
git push -u origin main
```

প্রথমবার পুশ করলে GitHub আপনার ইউজারনেম ও পাসওয়ার্ড (অথবা Personal Access Token) চাইতে পারে।

## ধাপ ৬: Personal Access Token তৈরি করুন (যদি প্রয়োজন হয়)

GitHub এখন পাসওয়ার্ড দিয়ে push করা সাপোর্ট করে না। Token লাগবে:

1. GitHub-এ **Settings → Developer settings → Personal access tokens → Tokens (classic)**
2. **Generate new token** চাপুন
3. `repo` স্কোপ সিলেক্ট করুন
4. Token কপি করুন (এটি একবারই দেখাবে!)
5. push করার সময় পাসওয়ার্ডের জায়গায় এই token ব্যবহার করুন

অথবা SSH ব্যবহার করুন (একবার সেটআপ করলে বারবার token লাগবে না):

```bash
ssh-keygen -t ed25519 -C "আপনার@ইমেইল.com"
cat ~/.ssh/id_ed25519.pub
# এই কী GitHub Settings → SSH and GPG keys এ যোগ করুন
```

তারপর remote URL পরিবর্তন করুন:
```bash
git remote set-url origin git@github.com:your-username/cryptoflip.git
```

## ধাপ ৭: যাচাই করুন

ব্রাউজারে আপনার GitHub রিপো খুলুন — সব ফাইল দেখতে পাবেন। `.env` ফাইল **দেখা উচিত নয়**।

## ভবিষ্যতে পরিবর্তন আপলোড করতে

প্রতিবার কোড পরিবর্তনের পর:

```bash
git add .
git commit -m "যা পরিবর্তন করেছেন তার সংক্ষিপ্ত বর্ণনা"
git push
```

## VPS-এ এই রিপো থেকে ডেপ্লয় করতে

`docs/DEPLOYMENT.md` ফাইলে সম্পূর্ণ নির্দেশনা আছে। সংক্ষেপে:

```bash
ssh root@your-server-ip
cd /opt/cryptoflip
git clone https://github.com/your-username/cryptoflip.git .
cp .env.example .env
nano .env  # প্রকৃত মান বসান
docker compose -f docker-compose.prod.yml up -d --build
```

## দল নিয়ে কাজ করার সময়

নতুন কেউ যোগ দিলে তাদের এই রিপো clone করতে বলুন:

```bash
git clone https://github.com/your-username/cryptoflip.git
cd cryptoflip
cp .env.example .env
# .env-এ নিজের লোকাল মান বসান
docker-compose up --build
```

`CONTRIBUTING.md` ফাইলে দলগত কাজের জন্য আরও নির্দেশনা আছে।
