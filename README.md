# Neuralix AI

A futuristic AI chatbot website with its own accounts, chat history, Free and Premium plans, and automatic GCash payments. It does not use Claude. Neuralix answers with an open-source AI model that you choose and control.

**What's included**

- Sign up and log in (email and password)
- AI chat that types out live, with image analysis and saved history
- Free plan: unlimited messages, Neuralix Core model, chat history, 10 image uploads per day
- Premium plan: unlimited messages and images, Nova and Ultra models, custom instructions, longer answers
- GCash checkout through PayMongo, with Premium turning on automatically after payment
- Owner console: members, Premium count, monthly GCash revenue, give or remove Premium
- Phone app: a **Get the Neuralix app** button, home-screen icon, full-screen app and an offline screen, ready to turn into an Android APK and Google Play app (step 5)
- No packages to install. It runs on Node.js 22.13 or newer.

---

## 1. Choose Neuralix's AI brain

Neuralix's knowledge comes from an open-source AI model (for example Qwen, Gemma or gpt-oss). These models were trained on a large part of the internet, so they already know a lot, the same way any chatbot does. Bigger models give smarter answers but need stronger hardware.

**Option A: fully your own (no outside AI company)**

1. Get a computer or cloud server with an NVIDIA GPU (16 GB of GPU memory or more is a good start).
2. Install Ollama from ollama.com.
3. Download the models:
   ```
   ollama pull qwen3:8b
   ollama pull gpt-oss:20b
   ollama pull qwen3-vl:8b
   ```
4. In your settings, use `AI_BASE_URL=http://YOUR-SERVER-IP:11434/v1`.

**Option B: no GPU needed**

Use Ollama Cloud, which runs open models for you. Set `AI_BASE_URL=https://ollama.com/v1` and put your Ollama API key in `AI_API_KEY`. Check which model names your account offers and put them in `MODEL_CORE`, `MODEL_NOVA`, `MODEL_ULTRA` and `MODEL_VISION`.

**Option C: Groq (free key, no GPU)**

Get a key at console.groq.com. Set `AI_BASE_URL=https://api.groq.com/openai/v1`, put the key in `AI_API_KEY`, and use model names from Groq's list, for example `MODEL_CORE=llama-3.1-8b-instant`, `MODEL_NOVA=llama-3.3-70b-versatile` and `MODEL_ULTRA=openai/gpt-oss-120b`. Two things to know:

- Groq's model list currently has **no model that can read images**, so image analysis won't work on Groq.
- A free Groq key has **daily limits shared by all your members**. When they run out, Neuralix can't answer until the next day. Groq's paid plan raises them.

Any other OpenAI-compatible AI service also works with the same two settings.

## 2. Set up GCash payments (PayMongo)

1. Create a PayMongo account at paymongo.com and complete business verification so you can accept live payments.
2. In the PayMongo dashboard, make sure **GCash** is turned on under payment methods.
3. Copy your **secret key**. Use the `sk_test_` key first, then the `sk_live_` key when you go live. Put it in `PAYMONGO_SECRET_KEY`.
4. Create a **webhook**:
   - URL: `https://YOUR-WEBSITE/api/billing/webhook`
   - Event: `checkout_session.payment.paid`
5. Copy the webhook's **signing secret** into `PAYMONGO_WEBHOOK_SECRET`.

When a member pays, PayMongo tells Neuralix and Premium turns on right away: 30 days for monthly, 365 days for yearly. Paying again extends the current Premium.

## 3. Put it online

**Option 1: Render (easiest)**

1. Upload this folder to a new GitHub repository.
2. On render.com, create a **Web Service** from that repository.
3. Build command: leave empty. Start command: `npm start`.
4. Add a **persistent disk** mounted at `/var/data`. **Render's free plan can't do this.** On the free plan, every account, chat and Premium payment is erased whenever the site restarts, redeploys or goes to sleep (after 15 minutes without visitors). Use a paid plan with a disk.
5. Add the settings from `.env.example` as environment variables, with `DATABASE_PATH=/var/data/neuralix.db` and `APP_URL` set to your Render address or your own domain.

**Option 2: any VPS with Docker**

```
cp .env.example .env        # then edit .env
docker build -t neuralix .
docker run -d --name neuralix -p 3000:3000 --env-file .env -v neuralix-data:/app/data --restart unless-stopped neuralix
```

Put it behind HTTPS (for example Caddy or Nginx with a free certificate). GCash and logins need HTTPS.

## 4. Open the Owner console

Put your email in `ADMIN_EMAILS`, sign up on the website with that email, and an **Owner console** link appears at the bottom of the sidebar. Use it to see members and revenue, and to give Premium to testers or to people who paid you directly.

## 5. Turn Neuralix into a phone app

The app is your Neuralix website on the member's phone, with its own icon and no browser bar. Accounts, chats, Free and Premium all stay the same, so the website must be online first (step 3).

**Install from your website (works as soon as it's online)**

- **Android:** members open your website in Chrome and tap **Get the Neuralix app** on the login page or in the chats menu, then **Install**. Neuralix appears with their other apps.
- **iPhone:** the same button shows the three **Add to Home Screen** steps for Safari.
- If someone opens your link inside Facebook or Messenger, the button first tells them to open it in Chrome or Safari, because those in-app browsers can't install apps.

**Get an APK and a Google Play file (free, with PWABuilder)**

1. Make sure Neuralix is online and opens at its `https://` address.
2. Go to **pwabuilder.com**, type your website address and tap **Start**.
3. Choose **Package for stores**, then **Android**, then **Generate**. For the package ID use something like `com.yourname.neuralix` (it can never change once it's on Google Play) and keep **Signing key: New**.
4. Download the zip. It contains:
   - an **.apk** you can install on Android phones or share directly
   - an **.aab** for uploading to Google Play
   - the **signing key** and its passwords. Keep both safe; every future update needs them.
   - an **assetlinks.json** file
5. Open `assetlinks.json`. Copy `package_name` into the `ANDROID_PACKAGE_ID` setting and the `sha256_cert_fingerprints` value into `ANDROID_CERT_SHA256`, then redeploy. Without this step the app shows a browser address bar at the top.
6. To publish on **Google Play**, you need a Google Play developer account (one-time US$25). Google signs your app with its own key, so copy the **App signing key** SHA-256 from Play Console (under App integrity) and add it to `ANDROID_CERT_SHA256`, separated by a comma. New personal developer accounts must run a closed test with at least 12 testers for 14 days before the app can go public.

The icons for the app and the Play Store listing are in `public/icons` (`icon-512.png` is the 512 × 512 store icon).

## Run it on your own computer

```
cp .env.example .env    # set APP_URL=http://localhost:3000 and NODE_ENV=development
npm start
```

Then open http://localhost:3000.

## Good to know

- The website's design and code are one file: `public/index.html`. After you edit it, restart the server so its security check accepts the new code. Next to it, `manifest.webmanifest` and `icons/` give the installed app its name and icon, and `sw.js` shows the offline screen.
- Free image uploads reset at midnight Philippine time.
- Neither plan has a daily message limit. To stop spam bots, Free members can send up to 20 messages a minute and Premium members up to 60 (one per second).
- When Premium runs out (or you remove it), the member goes back to Free automatically and keeps their chats.
- Back up the `data` folder (or your persistent disk) regularly. It holds every account, chat and payment.
- Images are shrunk on the member's phone before upload and are not stored; only the count is saved.
- Passwords are stored as salted scrypt hashes. Sessions use secure, HTTP-only cookies.

## Settings

| Setting | What it does |
|---|---|
| `APP_URL` | Your website address, used for GCash return links |
| `DATABASE_PATH` | Where the database file is saved |
| `ADMIN_EMAILS` | Emails that can open the Owner console |
| `AI_BASE_URL`, `AI_API_KEY` | Your AI server and its key |
| `MODEL_CORE`, `MODEL_NOVA`, `MODEL_ULTRA` | Model behind each Neuralix tier |
| `MODEL_VISION` | Model used for messages with images |
| `MAX_TOKENS_*` | Longest answer per tier |
| `FREE_IMAGES_PER_DAY` | Free image uploads per day (default 10) |
| `FREE_MESSAGES_PER_MINUTE`, `PREMIUM_MESSAGES_PER_MINUTE` | Anti-spam speed limit (default 20 and 60). There is no daily message limit. |
| `PRICE_MONTHLY`, `PRICE_ANNUAL` | Premium prices in pesos (default ₱199 and ₱1,910) |
| `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET` | Your PayMongo keys |
| `PAYMONGO_METHODS` | Payment methods on the checkout page (default `gcash`) |
| `ANDROID_PACKAGE_ID`, `ANDROID_CERT_SHA256` | From PWABuilder's `assetlinks.json`, so the Android app opens without a browser bar |
