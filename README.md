# 🎵 Nobu - Discord Music Bot

<p align="center">
  <strong>Nobu</strong> is a sleek, modern, and high-performance Discord music bot designed for 24/7 crystal-clear audio playback.
</p>

---

## ✨ Features

- 🎧 **Multi-Source Support:** Stream from **YouTube**, **Spotify** (tracks, albums, playlists), **SoundCloud**, and **Direct Audio Links** (`.mp3`, `.wav`, radio streams).
- 🎛️ **Interactive Player Controls:** Sleek Discord button UI directly beneath Now Playing embeds (⏯️ Pause/Resume, ⏭️ Skip, ⏹️ Stop, 🔁 Loop, 🔀 Shuffle).
- ⚡ **Full Slash Command Suite:** 16 slash commands with auto-completion and rich embed feedback.
- 💬 **Prefix Command Fallback:** Supports classic prefix commands (`!play`, `!skip`, `!stop`, etc.) alongside slash commands.
- 🎚️ **Built-in Sound Effects & Filters:** Bass Boost, Nightcore, 3D Surround, Echo, Karaoke, Vaporwave, Flanger.
- 📻 **Smart Autoplay:** Automatically queues related songs when your playlist finishes.
- 🌐 **Free Cloud Hosting Ready:** Includes a built-in lightweight HTTP health check endpoint (`GET /health`), `Dockerfile`, and `Procfile` ready for zero-downtime deployment.

---

## 📋 Slash Commands

| Command | Description |
| :--- | :--- |
| `/play <query> [source]` | Play a song or playlist (YouTube, Spotify, SoundCloud, direct link) |
| `/pause` | Pause current playback |
| `/resume` | Resume playback |
| `/skip` | Skip the current track |
| `/stop` | Stop playback, clear queue, and leave voice |
| `/nowplaying` | Display current track with interactive button controls |
| `/queue [page]` | View paginated list of upcoming songs |
| `/volume <1-100>` | Adjust player volume |
| `/loop <mode>` | Cycle repeat mode (`Off`, `Song`, `Queue`) |
| `/shuffle` | Shuffle upcoming songs in the queue |
| `/seek <seconds>` | Jump to a specific timestamp in the current song |
| `/autoplay` | Toggle smart auto-play when queue runs out |
| `/filter <effect>` | Apply or clear audio filters (Bassboost, Nightcore, 3D, etc.) |
| `/help` | View help guide and command list |
| `/ping` | Check bot latency and Discord API heartbeat |
| `/stats` | View memory usage, uptime, and server count |

---

## 🚀 Quick Setup Guide

### 1. Prerequisites
- **Node.js 18+** or higher (Node 20+ recommended)
- **Git**

### 2. Discord Developer Portal Setup
1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** and name it **Nobu**.
3. Under the **Bot** tab on the left:
   - Click **Reset Token** and copy your **Bot Token**.
   - Scroll down to **Privileged Gateway Intents** and enable:
     - ✅ **Server Members Intent**
     - ✅ **Message Content Intent**
4. Under the **General Information** tab, copy the **Application ID** (this is your `CLIENT_ID`).
5. Under the **OAuth2** -> **URL Generator** tab:
   - Select scopes: `bot` and `applications.commands`.
   - Select bot permissions:
     - `Send Messages`, `Embed Links`, `Attach Files`, `Read Message History`, `Add Reactions`
     - `Connect`, `Speak`, `Use Voice Activity`
   - Copy the generated URL and paste it into your browser to invite Nobu to your server.

### 3. Local Installation & Configuration
Clone or open the project directory:
```bash
cd Nobu
npm install
```

Configure environment variables in `.env`:
```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_bot_client_id_here
GUILD_ID=your_test_server_id_optional
PORT=3000
```

### 4. Register Slash Commands
Run the command deployment script:
```bash
npm run deploy-commands
```

### 5. Start Nobu
```bash
npm start
```

---

## ☁️ Step-by-Step: How to Free Host Nobu 24/7

Discord music bots require a hosting provider that allows persistent background processes and WebSocket connections. Here are the most reliable, completely free methods:

---

### Method 1: Koyeb (Recommended - Best 24/7 Free Tier)

Koyeb offers a generous free tier (Nano instance) that **never sleeps**, requires no credit card, and gives you a continuous containerized environment.

1. **Push your code to GitHub:**
   ```bash
   git init
   git add .
   git commit -m "Initial commit for Nobu bot"
   git branch -M main
   git remote add origin https://github.com/<your-username>/nobu.git
   git push -u origin main
   ```
   *(Note: Ensure `.env` is ignored by `.gitignore` so your bot token remains private!)*

2. **Sign up on Koyeb:**
   - Go to [koyeb.com](https://www.koyeb.com/) and sign up with GitHub.
3. **Create New Service:**
   - Click **Create App** -> choose **GitHub**.
   - Select your repository `nobu`.
   - Under **Builder**, select **Buildpack** or **Dockerfile**.
   - Under **Instance**, select **Free (Nano)**.
   - Under **Environment variables**, add:
     - `DISCORD_TOKEN` = `your_discord_bot_token`
     - `CLIENT_ID` = `your_application_client_id`
     - `PORT` = `3000`
   - Under **Ports**, ensure HTTP port is set to `3000` with path `/health`.
4. Click **Deploy**. Koyeb will build the image, start Nobu, and keep it running 24/7.

---

### Method 2: Render (Free Web Service + UptimeRobot)

Render provides free Web Services with 750 free instance hours per month (enough for the whole month!). To prevent the free tier from idling after 15 minutes of inactivity, we use UptimeRobot to ping the built-in health check endpoint.

1. Push your Nobu code to a GitHub repository.
2. Sign up at [render.com](https://render.com/).
3. Click **New +** -> **Web Service**.
4. Connect your GitHub repository.
5. Set:
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node src/index.js`
   - **Instance Type:** `Free`
6. Click **Advanced** -> **Add Environment Variable**:
   - `DISCORD_TOKEN` = `your_bot_token`
   - `CLIENT_ID` = `your_client_id`
   - `PORT` = `3000`
7. Click **Create Web Service**.
8. Once deployed, Render will provide a public URL like `https://nobu-xxxx.onrender.com`.
9. **Keep it awake 24/7:**
   - Sign up for free at [uptimerobot.com](https://uptimerobot.com/).
   - Click **Add New Monitor**.
   - Monitor Type: `HTTP(s)`.
   - URL: `https://nobu-xxxx.onrender.com/health`.
   - Interval: Every `5 minutes`.
   - Click **Create Monitor**. This pings Nobu every 5 minutes so it never goes into sleep mode.

---

### Method 3: Discloud (Dedicated Discord Bot Hosting)

Discloud is purpose-built specifically for hosting Discord bots with a generous free plan.

1. Create an account at [discloudbot.com](https://discloudbot.com/).
2. In your Nobu project, create a file named `discloud.config`:
   ```ini
   ID=nobu
   TYPE=bot
   MAIN=src/index.js
   NAME=Nobu
   AVATAR=
   RAM=100
   AUTORESTART=true
   VERSION=latest
   APT=ffmpeg
   ```
3. Zip your project files (excluding `node_modules`).
4. Upload the `.zip` file on the Discloud dashboard.
5. Set your environment variables (`DISCORD_TOKEN`, `CLIENT_ID`) in the Discloud panel.
6. Click **Start**.

---

### Method 4: Oracle Cloud Free Tier (Lifetime Always-Free VPS)

Oracle Cloud Infrastructure (OCI) offers an **Always Free** tier that includes free Compute VMs (ARM Ampere up to 4 OCPUs and 24 GB RAM, or 2 x86 instances) that never expire and run 24/7.

1. Sign up for [Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/).
2. Create an **Ubuntu 22.04 / 24.04** Always-Free Compute Instance.
3. SSH into your VPS:
   ```bash
   sudo apt update && sudo apt install -y nodejs npm ffmpeg git
   sudo npm install -g pm2
   ```
4. Clone your repository:
   ```bash
   git clone https://github.com/<your-username>/nobu.git
   cd nobu
   npm install
   cp .env.example .env # edit with nano .env
   npm run deploy-commands
   ```
5. Run 24/7 using PM2 process manager:
   ```bash
   pm2 start src/index.js --name nobu
   pm2 save
   pm2 startup
   ```

---

## 💡 Troubleshooting & Cloud Hosting Tips

### 1. YouTube 429 "Sign in to confirm you're not a bot"
Cloud hosting providers (like Render or Koyeb) share datacenter IP ranges with thousands of services, which can occasionally trigger YouTube rate limits or bot-verification blocks.
- **Solution:** Nobu has native **SoundCloud** and **Spotify** integrations! You can pass `/play query: song name source: SoundCloud (Most reliable on cloud hosts)` or simply paste Spotify/SoundCloud URLs. SoundCloud does not block cloud hosting IPs.

### 2. "Missing Permissions to Connect / Speak"
Ensure the bot's role in your Discord server has permissions to `Connect` and `Speak` in the target voice channel. Check channel-specific permission overrides.

### 3. Slash Commands Not Appearing
- Global commands can take 5-10 minutes to propagate across all Discord servers.
- For instantaneous updates while setting up, set your server's ID in `GUILD_ID` in `.env` and rerun:
  ```bash
  npm run deploy-commands
  ```

---

## 🌐 Live Web Dashboard (Hosted on Google Firebase)

Nobu includes a Google-hosted web dashboard (`web/`) powered by **Firebase Hosting**, **Firebase Authentication (Google Sign-In)**, and **Firebase Realtime Database**. It works even when Nobu runs on Discloud (`TYPE=bot`) or locally with no open inbound ports.

1. **Create a Firebase Project** at [console.firebase.google.com](https://console.firebase.google.com/):
   - Enable **Authentication -> Sign-in method -> Google**.
   - Enable **Realtime Database** (start in locked mode).
   - Register a **Web App** (`</>`) and copy its config into `web/firebase-config.js`.
2. **Restrict Access by Google Email:**
   - Replace `'you@gmail.com'` in `database.rules.json` with your Google email(s).
   - Optionally also add the same email(s) to `ALLOWED_EMAILS` in `web/firebase-config.js` and `DASHBOARD_ALLOWED_EMAILS` in `.env`.
3. **Connect Nobu to Realtime Database:**
   - In Firebase Console -> **Project Settings -> Service Accounts**, click **Generate new private key**.
   - Add to your `.env` (or Discloud/host environment variables):
     ```env
     FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com
     FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxx@your-project.iam.gserviceaccount.com
     FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
     DASHBOARD_ALLOWED_EMAILS=you@gmail.com
     ```
4. **Deploy to Google (`*.web.app`):**
   ```bash
   npx firebase-tools login
   npx firebase-tools use --add
   npx firebase-tools deploy
   ```

---

## 📜 License
Distributed under the MIT License.
