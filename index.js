/**
 * Cloudflare Worker version of the original PHP Telegram Mini App.
 * Storage: Cloudflare D1
 * Secrets: BOT_TOKEN, ADMIN_CHAT_ID
 */

const DEFAULT_SETTINGS = {
  currency: "BDT",
  dailyBonusAmount: 0.10,
  adRewardAmount: 0.10,
  dailyAdLimit: 10,
  withdrawMethods: "bKash:200, Nagad:200, Rocket:200, Binance:5",
  adsgramBlockId: "28773"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function nowDate() {
  return new Date().toISOString().slice(0, 10);
}

function safeUser(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    firstName: row.firstName || "Unknown",
    lastName: row.lastName || "",
    username: row.username || "",
    photoUrl: row.photoUrl || "",
    balance: Number(row.balance || 0),
    adsWatched: Number(row.adsWatched || 0),
    dailyAdsCount: Number(row.daily_ads_count || 0),
    dailyAdDate: row.daily_ad_date || "",
    lifetimeEarned: Number(row.lifetimeEarned || 0),
    lastBonusDate: row.lastBonusDate || "",
    withdrawHistory: []
  };
}

async function getSettings(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'app'").first();
  if (!row) return { ...DEFAULT_SETTINGS };
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}

async function saveSettings(db, settings) {
  await db.prepare("INSERT INTO settings(key,value) VALUES('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(JSON.stringify(settings)).run();
}

async function getWithdrawals(db, userId) {
  const { results } = await db.prepare(
    "SELECT id, created_at AS date, amount, method, address, status FROM withdrawals WHERE user_id=? ORDER BY id ASC"
  ).bind(String(userId)).all();
  return results || [];
}

/**
 * Validate Telegram WebApp initData using the bot token.
 * Telegram documents that initDataUnsafe must not be trusted.
 */
async function validateTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const secret = await crypto.subtle.sign(
    "HMAC",
    secretKey,
    new TextEncoder().encode(botToken)
  );

  const checkKey = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    checkKey,
    new TextEncoder().encode(dataCheckString)
  );

  const expected = [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== receivedHash.length) return null;

  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ receivedHash.charCodeAt(i);
  if (diff !== 0) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;

  let user;
  try { user = JSON.parse(params.get("user") || "null"); } catch { return null; }
  return user && user.id ? user : null;
}

async function requireUser(request, env, input) {
  const user = await validateTelegramInitData(input?.initData, env.BOT_TOKEN);
  if (!user) throw new Error("Invalid or expired Telegram session");

  const id = String(user.id);
  let row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();

  if (!row) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO users(id, firstName, lastName, username, photoUrl, balance, adsWatched, lifetimeEarned, lastBonusDate)
      VALUES(?,?,?,?,?,?,?,?,?)
    `).bind(
      id, user.first_name || "Unknown", user.last_name || "", user.username || "",
      user.photo_url || "", 0, 0, 0, ""
    ).run();
    row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
  } else {
    await env.DB.prepare(
      "UPDATE users SET firstName=?, lastName=?, username=?, photoUrl=? WHERE id=?"
    ).bind(user.first_name || "", user.last_name || "", user.username || "", user.photo_url || "", id).run();
    row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
  }

  return { user, row, isAdmin: id === String(env.ADMIN_CHAT_ID) };
}

async function userPayload(db, row, settings) {
  const u = safeUser(row);
  u.withdrawHistory = await getWithdrawals(db, u.id);
  const today = nowDate();
  return { user: u, bonusClaimed: u.lastBonusDate === today, settings };
}

async function sendTelegram(env, text) {
  if (!env.BOT_TOKEN || !env.ADMIN_CHAT_ID) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.ADMIN_CHAT_ID, text })
    });
    return res.ok;
  } catch (error) {
    console.error("Telegram admin notification failed", error);
    return false;
  }
}

async function telegramApi(env, method, payload) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN is not configured");
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(data?.description || `Telegram API error: ${res.status}`);
  return data.result;
}

async function handleTelegramWebhook(request, env) {
  if (request.method !== "POST") return new Response("OK", { status: 200 });
  const configuredSecret = String(env.WEBHOOK_SECRET || "");
  if (configuredSecret) {
    const received = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (received !== configuredSecret) return new Response("Unauthorized", { status: 401 });
  }
  let update;
  try { update = await request.json(); } catch { return new Response("Bad Request", { status: 400 }); }
  const message = update?.message;
  if (!message?.chat?.id) return new Response("OK", { status: 200 });
  const text = String(message.text || "").trim();
  if (text === "/start" || text.startsWith("/start ")) {
    await telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text: `Welcome ${message.from?.first_name || "there"} 👋\n\nOpen Zelvuno to earn rewards, claim your daily bonus, watch ads and manage withdrawals.`,
      reply_markup: { inline_keyboard: [[{ text: "🚀 Open Zelvuno", web_app: { url: "https://mdm.malakmalki125.workers.dev" } }]] }
    });
  } else if (text === "/help") {
    await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "Use /start to open Zelvuno." });
  }
  return new Response("OK", { status: 200 });
}

async function handleApi(request, env) {
  if (!env.DB) return json({ success: false, message: "D1 database binding DB is missing" }, 500);

  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "";
  let input = {};
  try { input = await request.json(); } catch {}

  try {
    if (action === "sync_user") {
      const auth = await requireUser(request, env, input);
      const settings = await getSettings(env.DB);
      const payload = await userPayload(env.DB, auth.row, settings);

      if (auth.isAdmin) {
        const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY id DESC").all();
        const all = {};
        for (const r of results || []) {
          const u = safeUser(r);
          u.withdrawHistory = await getWithdrawals(env.DB, u.id);
          all[u.id] = u;
        }
        payload.all_users = all;
      }
      return json({ success: true, ...payload, isAdmin: auth.isAdmin });
    }

    if (action === "add_reward") {
      const auth = await requireUser(request, env, input);
      const settings = await getSettings(env.DB);
      const type = input.type;

      if (type === "bonus") {
        const today = nowDate();
        const result = await env.DB.prepare(
          "UPDATE users SET balance=balance+?, lifetimeEarned=lifetimeEarned+?, lastBonusDate=? WHERE id=? AND lastBonusDate<>?"
        ).bind(Number(settings.dailyBonusAmount), Number(settings.dailyBonusAmount), today, String(auth.user.id), today).run();
        if (!result.meta.changes) return json({ success: false, message: "Already claimed" }, 400);
      } else if (type === "ad") {
        const row = await env.DB.prepare("SELECT adsWatched FROM users WHERE id=?").bind(String(auth.user.id)).first();
        const watched = Number(row?.adsWatched || 0);
        const limit = Number(settings.dailyAdLimit || 10);
        // Daily counters should be used in production. This field is retained for compatibility;
        // see schema for daily_ad_date/daily_ads_count.
        const today = nowDate();
        const result = await env.DB.prepare(`
          UPDATE users
          SET balance=balance+?, lifetimeEarned=lifetimeEarned+?, adsWatched=adsWatched+1,
              daily_ad_date=CASE WHEN daily_ad_date=? THEN daily_ad_date ELSE ? END,
              daily_ads_count=CASE WHEN daily_ad_date=? THEN daily_ads_count+1 ELSE 1 END
          WHERE id=? AND (daily_ad_date<>? OR daily_ad_date IS NULL OR daily_ads_count<?)
        `).bind(
          Number(settings.adRewardAmount), Number(settings.adRewardAmount),
          today, today, today, String(auth.user.id), today, limit
        ).run();
        if (!result.meta.changes) return json({ success: false, message: "Daily ad limit reached" }, 400);
      } else {
        return json({ success: false, message: "Invalid reward type" }, 400);
      }

      const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(String(auth.user.id)).first();
      const payload = await userPayload(env.DB, row, settings);
      return json({ success: true, ...payload });
    }

    if (action === "withdraw") {
      const auth = await requireUser(request, env, input);
      const settings = await getSettings(env.DB);
      const amount = Number(input.amount);
      const method = String(input.method || "").trim();
      const address = String(input.address || "").trim();

      if (!amount || amount <= 0 || !method || !address) return json({ success: false, message: "Invalid withdrawal" }, 400);

      const methods = String(settings.withdrawMethods || "").split(",").map(x => {
        const [name, min] = x.split(":");
        return { name: String(name || "").trim(), min: Number(min || 0) };
      });
      const selected = methods.find(x => x.name === method);
      if (!selected) return json({ success: false, message: "Invalid payment method" }, 400);
      if (amount < selected.min) return json({ success: false, message: `Minimum withdrawal is ${selected.min}` }, 400);

      if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) {
        return json({ success: false, message: "Invalid withdrawal amount" }, 400);
      }
      const userId = String(auth.user.id);
      const batch = await env.DB.batch([
        env.DB.prepare("UPDATE users SET balance=balance-? WHERE id=? AND balance>=?").bind(amount, userId, amount),
        env.DB.prepare("INSERT INTO withdrawals(user_id, amount, method, address, status, created_at) VALUES(?,?,?,?,?,?)").bind(userId, amount, method, address, "Pending", new Date().toISOString())
      ]);
      if (!batch[0]?.meta?.changes) return json({ success: false, message: "Insufficient balance" }, 400);

      const name = `${auth.user.first_name || ""} ${auth.user.last_name || ""}`.trim();
      const currency = settings.currency || "BDT";
      await sendTelegram(env,
        `🚨 *New Withdraw Request*\\n\\n👤 *Name:* ${name}\\n🆔 *ID:* \`${auth.user.id}\`\\n💵 *Amount:* ${amount.toFixed(2)} ${currency}\\n🏦 *Method:* ${method}\\n📍 *Account:* \`${address}\``
      );

      const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(String(auth.user.id)).first();
      return json({ success: true, ...(await userPayload(env.DB, row, settings)) });
    }

    if (action === "update_settings") {
      const auth = await requireUser(request, env, input);
      if (!auth.isAdmin) return json({ success: false, message: "Unauthorized" }, 403);

      const old = await getSettings(env.DB);
      const incoming = input.settings || {};
      const dailyBonusAmount = Number(incoming.dailyBonusAmount ?? old.dailyBonusAmount);
      const adRewardAmount = Number(incoming.adRewardAmount ?? old.adRewardAmount);
      const dailyAdLimit = Number(incoming.dailyAdLimit ?? old.dailyAdLimit);
      const currency = String(incoming.currency ?? old.currency).trim();
      const withdrawMethods = String(incoming.withdrawMethods ?? old.withdrawMethods).trim();
      const adsgramBlockId = String(incoming.adsgramBlockId ?? old.adsgramBlockId).trim();
      if (!currency || !Number.isFinite(dailyBonusAmount) || dailyBonusAmount < 0 ||
          !Number.isFinite(adRewardAmount) || adRewardAmount < 0 ||
          !Number.isInteger(dailyAdLimit) || dailyAdLimit < 0 || dailyAdLimit > 1000 ||
          !withdrawMethods) {
        return json({ success: false, message: "Invalid settings" }, 400);
      }
      const settings = { ...old, currency, dailyBonusAmount, adRewardAmount, dailyAdLimit, withdrawMethods, adsgramBlockId };
      await saveSettings(env.DB, settings);
      return json({ success: true, settings });
    }

    if (action === "edit_balance") {
      const auth = await requireUser(request, env, input);
      if (!auth.isAdmin) return json({ success: false, message: "Unauthorized" }, 403);
      const target = String(input.target_user || "");
      const newBal = Number(input.new_balance);
      if (!target || !Number.isFinite(newBal) || newBal < 0) return json({ success: false, message: "Invalid balance" }, 400);
      const r = await env.DB.prepare("UPDATE users SET balance=? WHERE id=?").bind(newBal, target).run();
      return json({ success: !!r.meta.changes });
    }

    if (action === "update_withdraw_status") {
      const auth = await requireUser(request, env, input);
      if (!auth.isAdmin) return json({ success: false, message: "Unauthorized" }, 403);

      const target = String(input.target_user || "");
      const id = Number(input.index); // withdrawal id in the new implementation
      const newStatus = String(input.status || "");
      if (!["Completed", "Cancelled"].includes(newStatus)) return json({ success: false, message: "Invalid status" }, 400);

      const req = await env.DB.prepare("SELECT * FROM withdrawals WHERE id=? AND user_id=?").bind(id, target).first();
      if (!req) return json({ success: false, message: "Withdrawal not found" }, 404);
      if (req.status !== "Pending") return json({ success: false, message: "Already processed" }, 400);

      if (newStatus === "Cancelled") {
        const batch = await env.DB.batch([
          env.DB.prepare("UPDATE users SET balance=balance+(SELECT amount FROM withdrawals WHERE id=? AND status='Pending') WHERE id=?").bind(id, target),
          env.DB.prepare("UPDATE withdrawals SET status='Cancelled' WHERE id=? AND status='Pending'").bind(id)
        ]);
        if (!batch[1]?.meta?.changes) return json({ success: false, message: "Already processed" }, 400);
      } else {
        const result = await env.DB.prepare("UPDATE withdrawals SET status='Completed' WHERE id=? AND status='Pending'").bind(id).run();
        if (!result.meta.changes) return json({ success: false, message: "Already processed" }, 400);
      }
      return json({ success: true });
    }

    return json({ success: false, message: "Unknown action" }, 404);
  } catch (err) {
    console.error(err);
    return json({ success: false, message: err.message || "Server error" }, 500);
  }
}

const HTML = "\n\n<!-- =========================== HTML FRONTEND =========================== -->\n<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\" />\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0\" />\n  <title>Premium Task App</title>\n  \n  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n  <link href=\"https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap\" rel=\"stylesheet\" media=\"print\" onload=\"this.media='all'\">\n  <link href=\"https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css\" rel=\"stylesheet\" crossorigin=\"anonymous\" media=\"print\" onload=\"this.media='all'\" />\n  <link href=\"https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.css\" rel=\"stylesheet\" media=\"print\" onload=\"this.media='all'\">\n  \n  <style>\n    :root { \n        --bg-body: #050b14; \n        --bg-surface: rgba(16, 25, 43, 0.6); \n        --bg-surface-light: rgba(26, 38, 65, 0.8); \n        --border-color: rgba(255, 255, 255, 0.08); \n        --accent-primary: #00d2ff; \n        --accent-secondary: #3a7bd5; \n        --accent-success: #00f260; \n        --accent-warning: #f7b733; \n        --accent-danger: #fc4a1a; \n        --text-main: #ffffff; \n        --text-muted: #a0aec0; \n    }\n    body { background-color: var(--bg-body); background-image: radial-gradient(circle at top right, rgba(58,123,213,0.15), transparent 400px), radial-gradient(circle at bottom left, rgba(0,210,255,0.1), transparent 400px); color: var(--text-main); font-family: 'Outfit', sans-serif; padding-bottom: 110px; min-height: 100vh; }\n    \n    .text-muted { color: var(--text-muted) !important; }\n    .text-secondary { color: #cbd5e1 !important; }\n    \n    .premium-card { background: var(--bg-surface-light); backdrop-filter: blur(16px); border: 1px solid var(--border-color); border-radius: 20px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3); transition: transform 0.3s ease; }\n    \n    .premium-input { background: rgba(0, 0, 0, 0.25) !important; border: 1px solid rgba(255, 255, 255, 0.15) !important; color: white !important; border-radius: 14px; padding: 14px 18px; }\n    .premium-input:focus { border-color: var(--accent-primary) !important; box-shadow: 0 0 0 3px rgba(0, 210, 255, 0.2) !important; }\n    .premium-input::placeholder { color: rgba(255, 255, 255, 0.4) !important; }\n    \n    .btn-primary-custom { background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); color: #fff; border: none; border-radius: 14px; padding: 16px 24px; font-weight: 600; box-shadow: 0 6px 20px rgba(58, 123, 213, 0.4); transition: 0.3s; }\n    .btn-primary-custom:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }\n    .btn-outline-custom { background: transparent; color: var(--accent-primary); border: 2px solid var(--accent-primary); border-radius: 12px; padding: 10px 20px; font-weight: 600; transition: 0.3s; }\n    \n    .top-nav { background: rgba(5, 11, 20, 0.85); backdrop-filter: blur(20px); border-bottom: 1px solid var(--border-color); padding: 15px 0; position: sticky; top: 0; z-index: 1000; }\n    .profile-pic { width: 50px; height: 50px; object-fit: cover; border-radius: 50%; border: 2px solid var(--accent-primary); background: #1a2641; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1.3rem; color: var(--accent-primary); padding: 2px; }\n    .profile-pic img { border-radius: 50%; width: 100%; height: 100%; object-fit: cover; }\n    \n    .metric-box { background: rgba(0,0,0,0.3); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 16px; padding: 15px; text-align: center; }\n    .progress-slim { height: 8px; background-color: rgba(255,255,255,0.1); border-radius: 10px; overflow: hidden; }\n    .progress-slim .progress-bar { background: linear-gradient(90deg, var(--accent-secondary), var(--accent-primary)); }\n    \n    .app-bottom-nav { position: fixed; bottom: 0; left: 0; right: 0; background: rgba(16, 25, 43, 0.95); backdrop-filter: blur(25px); border-top: 1px solid var(--border-color); display: flex; justify-content: space-around; align-items: center; height: 85px; z-index: 999; border-radius: 30px 30px 0 0; }\n    .nav-item { text-decoration: none; display: flex; flex-direction: column; align-items: center; color: var(--text-muted); font-size: 0.85rem; flex: 1; cursor: pointer; transition: 0.3s; }\n    .nav-item i { font-size: 1.5rem; margin-bottom: 4px; transition: 0.3s; }\n    .nav-item.active { color: var(--accent-primary); font-weight: 600; }\n    .nav-item.active i { transform: translateY(-4px); text-shadow: 0 0 15px var(--accent-primary); }\n    \n    .chip { background: rgba(0, 210, 255, 0.1); border: 1px solid rgba(0, 210, 255, 0.3); padding: 6px 14px; border-radius: 30px; font-size: 0.9rem; display: inline-flex; align-items: center; gap: 8px; color: var(--accent-primary); font-weight: 600;}\n    \n    .history-item { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); padding: 12px; border-radius: 12px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }\n    .badge-pending { background: rgba(247, 183, 51, 0.15); color: var(--accent-warning); padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; border: 1px solid rgba(247, 183, 51, 0.3); }\n    .badge-completed { background: rgba(0, 242, 96, 0.15); color: var(--accent-success); padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; border: 1px solid rgba(0, 242, 96, 0.3); }\n    .badge-cancelled { background: rgba(252, 74, 26, 0.15); color: var(--accent-danger); padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; border: 1px solid rgba(252, 74, 26, 0.3); }\n\n    .toast-area { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 5000; width: 90%; max-width: 350px; }\n    .toast-pop { background: var(--bg-surface-light); backdrop-filter: blur(20px); border: 1px solid var(--border-color); border-radius: 16px; padding: 15px; display: flex; align-items: center; gap: 12px; opacity: 0; transition: 0.3s ease; box-shadow: 0 10px 30px rgba(0,0,0,0.5); margin-bottom: 10px; }\n    .toast-pop.success i { color: var(--accent-success); } .toast-pop.danger i { color: var(--accent-danger); } .toast-pop.warning i { color: var(--accent-warning); }\n\n    .loading-spinner { background: var(--bg-body); z-index: 9999; }\n    \n    .custom-modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); backdrop-filter: blur(5px); z-index: 6000; display: none; align-items: center; justify-content: center; }\n    .custom-modal { background: var(--bg-surface-light); border: 1px solid var(--border-color); border-radius: 20px; padding: 25px; width: 90%; max-width: 350px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }\n  \n    /* Critical fallback: app must remain usable even if CDN CSS is unavailable. */\n    .d-none{display:none!important}.d-flex{display:flex!important}.position-fixed{position:fixed!important}.top-0{top:0!important}.start-0{left:0!important}.w-100{width:100%!important}.h-100{height:100%!important}.align-items-center{align-items:center!important}.justify-content-center{justify-content:center!important}\n  </style>\n</head>\n<body>\n\n  <!-- Loading Spinner -->\n  <div class=\"loading-spinner position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center\" id=\"loading-spinner\">\n    <div class=\"spinner-border text-info\" style=\"width: 3rem; height: 3rem;\" role=\"status\"></div>\n  </div>\n\n  <!-- Edit Balance Modal -->\n  <div class=\"custom-modal-overlay\" id=\"editModalOverlay\">\n    <div class=\"custom-modal\">\n        <h5 class=\"text-white mb-3\">Edit User Balance</h5>\n        <input type=\"hidden\" id=\"editUid\">\n        <div class=\"mb-3\">\n            <label class=\"text-muted small mb-1\">New Balance</label>\n            <input type=\"number\" step=\"0.01\" id=\"editBalInput\" class=\"form-control premium-input\">\n        </div>\n        <div class=\"d-flex gap-2\">\n            <button class=\"btn btn-secondary w-50 rounded-3\" onclick=\"closeEditModal()\">Cancel</button>\n            <button class=\"btn btn-info w-50 rounded-3 text-dark fw-bold\" onclick=\"saveEditedBalance()\">Save</button>\n        </div>\n    </div>\n  </div>\n\n  <nav class=\"top-nav shadow-sm\">\n    <div class=\"container d-flex align-items-center justify-content-between\">\n      <div class=\"d-flex align-items-center gap-3\">\n        <div class=\"profile-pic\" id=\"headerProfilePic\"><i class=\"bi bi-person\"></i></div>\n        <div class=\"lh-1\">\n          <div class=\"text-muted small mb-1\">Hello, Tasker</div>\n          <h6 class=\"mb-0 fw-bold text-white UserName\" id=\"headerUserName\">Loading...</h6>\n        </div>\n      </div>\n      <div>\n        <div class=\"chip\">\n          <i class=\"bi bi-wallet2\"></i> <span class=\"user-balance\" id=\"globalBalance\">0.00</span>\n        </div>\n      </div>\n    </div>\n  </nav>\n\n  <main class=\"container py-4\">\n    <!-- HOME SECTION -->\n    <section id=\"home\">\n      <div class=\"premium-card p-4 mb-4 text-center\" style=\"background: linear-gradient(145deg, rgba(26, 38, 65, 0.9), rgba(16, 25, 43, 0.9));\">\n        <h6 class=\"text-muted fw-medium mb-1\">Total Available Balance</h6>\n        <h1 class=\"fw-bold mb-0 text-white user-balance display-4\" id=\"homeBalance\">0.00</h1>\n      </div>\n\n      <div class=\"premium-card p-3 mb-4 d-flex justify-content-between align-items-center\">\n        <div class=\"d-flex align-items-center gap-3\">\n          <div class=\"bg-warning bg-opacity-10 p-2 rounded-circle text-warning fs-3 lh-1\"><i class=\"bi bi-gift\"></i></div>\n          <div>\n            <h6 class=\"text-white fw-bold mb-0\">Daily Bonus</h6>\n            <small class=\"text-muted\" id=\"daily-bonus-text\">Get free cash daily</small>\n          </div>\n        </div>\n        <button id=\"claim-daily-bonus\" class=\"btn btn-sm btn-outline-custom\">Claim</button>\n      </div> \n\n      <div class=\"row g-2 mb-4\">\n        <div class=\"col-4\"><div class=\"metric-box\"><i class=\"bi bi-bullseye text-info fs-4 d-block mb-1\"></i><small class=\"text-muted d-block\">Limit</small><strong class=\"fs-5 text-white taskCount\">0</strong></div></div>\n        <div class=\"col-4\"><div class=\"metric-box\"><i class=\"bi bi-check2-circle text-success fs-4 d-block mb-1\"></i><small class=\"text-muted d-block\">Done</small><strong class=\"fs-5 text-white tasksCompleted\">0</strong></div></div>\n        <div class=\"col-4\"><div class=\"metric-box\"><i class=\"bi bi-clock-history text-warning fs-4 d-block mb-1\"></i><small class=\"text-muted d-block\">Left</small><strong class=\"fs-5 text-white tasksRemaining\">0</strong></div></div>\n      </div>\n\n      <div class=\"premium-card p-4\">\n        <div class=\"d-flex justify-content-between small text-muted mb-2\">\n            <span>Today's Target</span>\n            <span id=\"progress-percent\">0%</span>\n        </div>\n        <div class=\"progress progress-slim mb-4\">\n          <div class=\"progress-bar\" id=\"progressBarFill\" style=\"width: 0%\"></div>\n        </div>\n        <button id=\"show-ad\" class=\"btn btn-primary-custom w-100 fs-5\">\n          <i class=\"bi bi-play-circle me-2\"></i> Start Earning Task\n        </button>\n      </div>\n    </section>\n\n    <!-- WITHDRAW SECTION -->\n    <section class=\"d-none\" id=\"withdraw\">\n      <div class=\"premium-card p-4 mb-4 text-center\">\n        <i class=\"bi bi-bank text-info display-4 mb-2 d-block\"></i>\n        <h4 class=\"fw-bold text-white mb-1\">Withdraw Funds</h4>\n        <p class=\"text-muted mb-0\">Current: <span class=\"user-balance fw-bold text-white\">0.00</span></p>\n      </div>\n      \n      <div class=\"premium-card p-4\">\n        <form id=\"withdraw-form\">\n          <div class=\"mb-3\">\n            <label class=\"text-muted small mb-1\">Select Payment Method</label>\n            <select class=\"form-select premium-input\" id=\"payment-method\" required onchange=\"updateMinLimit()\"></select>\n            <small class=\"text-info mt-1 d-block\" id=\"min-limit-text\"></small>\n          </div>\n          <div class=\"mb-3\">\n            <label class=\"text-muted small mb-1\">Amount</label>\n            <input type=\"number\" step=\"0.01\" class=\"form-control premium-input\" id=\"withdraw-amount\" placeholder=\"Enter amount\" required />\n          </div>\n          <div class=\"mb-4\">\n            <label class=\"text-muted small mb-1\">Account Number / Address</label>\n            <input type=\"text\" class=\"form-control premium-input\" id=\"withdraw-address\" placeholder=\"Enter details...\" required />\n          </div>\n          <button type=\"button\" class=\"btn btn-primary-custom w-100\" id=\"submitWithdrawBtn\">Submit Request</button>\n        </form>\n      </div>\n    </section>\n\n    <!-- PROFILE SECTION -->\n    <section class=\"d-none\" id=\"profile\">\n      <div class=\"premium-card p-4 text-center mb-4\">\n        <div class=\"profile-pic mx-auto mb-3\" id=\"profileLargeAvatar\" style=\"width: 80px; height: 80px; font-size: 2rem;\"><i class=\"bi bi-person\"></i></div>\n        <h5 class=\"text-white fw-bold mb-0 UserName\">Loading...</h5>\n        <div class=\"text-muted small mb-3\" id=\"profileUserUsername\">@user</div>\n        \n        <div class=\"row g-2 text-start\">\n            <div class=\"col-6\"><div class=\"bg-dark bg-opacity-50 p-3 rounded-4 border border-secondary border-opacity-25\"><small class=\"text-muted d-block\">Total Earned</small><strong class=\"text-success fs-5\" id=\"lifetimeEarning\">0.00</strong></div></div>\n            <div class=\"col-6\"><div class=\"bg-dark bg-opacity-50 p-3 rounded-4 border border-secondary border-opacity-25\"><small class=\"text-muted d-block\">Ads Watched</small><strong class=\"text-info fs-5\" id=\"adsWatchedCount\">0</strong></div></div>\n        </div>\n      </div>\n\n      <h6 class=\"text-muted mb-3 px-2\"><i class=\"bi bi-clock-history me-2\"></i>Withdraw History</h6>\n      <div id=\"withdraw-history-list\"></div>\n    </section>\n\n    <!-- ADMIN PANEL SECTION -->\n    <section class=\"d-none\" id=\"admin-panel\">\n      <div class=\"premium-card p-4 mb-4 text-center border-danger border-opacity-50\">\n        <i class=\"bi bi-shield-lock text-danger display-5 mb-2 d-block\"></i>\n        <h4 class=\"fw-bold text-white mb-0\">Admin Access</h4>\n      </div>\n\n      <div class=\"premium-card p-4 mb-4\">\n        <h6 class=\"text-white mb-3\"><i class=\"bi bi-sliders me-2 text-info\"></i> App Configuration</h6>\n        <form id=\"admin-settings-form\">\n          <div class=\"row g-3 mb-3\">\n            <div class=\"col-12\">\n              <label class=\"text-muted small mb-1\">App Currency (e.g., BDT, ৳, USDT, $)</label>\n              <input type=\"text\" class=\"form-control premium-input border-info\" id=\"admin-currency\" placeholder=\"BDT\" />\n            </div>\n            <div class=\"col-6\">\n              <label class=\"text-muted small mb-1\">Daily Bonus</label>\n              <input type=\"number\" step=\"0.01\" class=\"form-control premium-input\" id=\"admin-daily-bonus\" />\n            </div>\n            <div class=\"col-6\">\n              <label class=\"text-muted small mb-1\">Ad Reward</label>\n              <input type=\"number\" step=\"0.01\" class=\"form-control premium-input\" id=\"admin-ad-reward\" />\n            </div>\n          </div>\n          <div class=\"mb-3\">\n            <label class=\"text-muted small mb-1\">Adsgram Block ID</label>\n            <input type=\"text\" class=\"form-control premium-input border-warning\" id=\"admin-block-id\" placeholder=\"e.g. 28773\"/>\n          </div>\n          <div class=\"mb-3\">\n            <label class=\"text-muted small mb-1\">Withdraw Methods (Method:MinLimit)</label>\n            <input type=\"text\" class=\"form-control premium-input\" id=\"admin-withdraw-methods\" placeholder=\"bKash:200, Nagad:150\" />\n            <small class=\"text-muted mt-1\">Example: bKash:200, Nagad:200, Binance:5</small>\n          </div>\n          <div class=\"mb-3\">\n            <label class=\"text-muted small mb-1\">Daily Ad Limit</label>\n            <input type=\"number\" class=\"form-control premium-input\" id=\"admin-ad-limit\" />\n          </div>\n          <div class=\"mb-4\">\n            <div class=\"alert alert-warning small mb-0\">Telegram Bot Token is securely stored in Cloudflare Secrets and is not editable from the app.</div>\n          </div>\n          <button type=\"button\" class=\"btn btn-danger w-100 fw-bold rounded-3 py-3\" id=\"saveAdminSettingsBtn\">Save All Configurations</button>\n        </form>\n      </div>\n\n      <div class=\"premium-card p-0 mb-4 overflow-hidden\">\n        <div class=\"p-3 border-bottom border-secondary border-opacity-25 bg-dark bg-opacity-50\">\n            <h6 class=\"text-white mb-0\"><i class=\"bi bi-people me-2 text-success\"></i> Users Management</h6>\n        </div>\n        <div class=\"table-responsive\">\n          <table class=\"table table-borderless table-hover align-middle mb-0 text-white\">\n            <thead class=\"bg-dark bg-opacity-50 text-muted small\">\n              <tr>\n                <th class=\"py-3 px-3\">User</th>\n                <th class=\"py-3 text-center\">Ads</th>\n                <th class=\"py-3 text-end px-3\">Balance / Edit</th>\n              </tr>\n            </thead>\n            <tbody id=\"admin-user-list\"></tbody>\n          </table>\n        </div>\n      </div>\n\n      <!-- Withdraw Requests Management -->\n      <div class=\"premium-card p-0 mb-4 overflow-hidden\">\n        <div class=\"p-3 border-bottom border-secondary border-opacity-25 bg-dark bg-opacity-50\">\n            <h6 class=\"text-white mb-0\"><i class=\"bi bi-cash-coin me-2 text-warning\"></i> Withdraw Requests</h6>\n        </div>\n        <div class=\"table-responsive\">\n          <table class=\"table table-borderless table-hover align-middle mb-0 text-white\">\n            <thead class=\"bg-dark bg-opacity-50 text-muted small\">\n              <tr>\n                <th class=\"py-3 px-3\">User Details</th>\n                <th class=\"py-3 text-center\">Amount & Info</th>\n                <th class=\"py-3 text-end px-3\">Action</th>\n              </tr>\n            </thead>\n            <tbody id=\"admin-withdraw-list\"></tbody>\n          </table>\n        </div>\n      </div>\n    </section>\n  </main>\n\n  <footer class=\"app-bottom-nav shadow-lg\">\n    <div onclick=\"showSection('profile')\" class=\"nav-item\" data-section=\"profile\"><i class=\"bi bi-person-badge\"></i><span>Profile</span></div>\n    <div onclick=\"showSection('home')\" class=\"nav-item active\" data-section=\"home\"><i class=\"bi bi-house-door\"></i><span>Home</span></div>\n    <div onclick=\"showSection('withdraw')\" class=\"nav-item\" data-section=\"withdraw\"><i class=\"bi bi-wallet2\"></i><span>Withdraw</span></div>\n    <div onclick=\"showSection('admin-panel')\" class=\"nav-item d-none\" id=\"admin-nav-item\" data-section=\"admin-panel\"><i class=\"bi bi-shield-check\"></i><span>Admin</span></div>\n  </footer>\n\n  <div id=\"toast-area\" class=\"toast-area\"></div>\n\n\n  <script>\n    let IS_ADMIN = false;    let telegramInitData = \"\";\n    \n    let currentUser = { id: \"guest\", firstName: \"Loading\", balance: 0, adsWatched: 0, lifetimeEarned: 0, withdrawHistory:[] };\n    let appSettings = {};\n    let allUsersData = {};\n    let dailyBonusClaimed = false;\n    let AdController = null;\n\n    function toggleLoading(show) {\n        const loader = document.getElementById(\"loading-spinner\");\n        if (!loader) return;\n        loader.classList.toggle(\"d-none\", !show);\n        loader.classList.toggle(\"d-flex\", show);\n    }\n\n    function showToast(msg, type = \"success\") {\n      const area = document.getElementById(\"toast-area\");\n      if (!area) return;\n      const icon = type === 'success' ? 'bi-check-circle-fill' : type === 'danger' ? 'bi-exclamation-octagon-fill' : 'bi-info-circle-fill';\n      const t = document.createElement(\"div\"); t.className = `toast-pop ${type}`;\n      t.textContent = String(msg ?? '');\n      const iconEl = document.createElement('i'); iconEl.className = `bi ${icon} fs-3`;\n      const wrap = document.createElement('div'); wrap.className='small text-light'; wrap.textContent=String(msg ?? '');\n      t.textContent=''; t.append(iconEl, wrap); area.appendChild(t);\n      setTimeout(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; }, 10);\n      setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);\n    }\n\n    function formatCur(amount) {\n        let cur = appSettings.currency || 'BDT';\n        const n = Number(amount || 0);\n        return (Number.isFinite(n) ? n : 0).toFixed(2) + ' ' + cur;\n    }\n\n    function loadAdsgram() {\n      return new Promise((resolve, reject) => {\n        if (window.Adsgram) return resolve();\n        const existing = document.querySelector('script[data-adsgram]');\n        if (existing) {\n          existing.addEventListener('load', () => resolve(), {once:true});\n          existing.addEventListener('error', () => reject(new Error('Adsgram failed to load')), {once:true});\n          return;\n        }\n        const s = document.createElement('script');\n        s.src = 'https://sad.adsgram.ai/js/sad.min.js'; s.async = true; s.dataset.adsgram='1';\n        const timer = setTimeout(() => reject(new Error('Ads service timed out')), 10000);\n        s.onload = () => { clearTimeout(timer); window.Adsgram ? resolve() : reject(new Error('Adsgram is unavailable')); };\n        s.onerror = () => { clearTimeout(timer); reject(new Error('Adsgram failed to load')); };\n        document.head.appendChild(s);\n      });\n    }\n\n    async function syncBackend(tgUser) {\n        toggleLoading(true);\n        try {\n            const initData = tgUser?.initData || telegramInitData || '';\n            if (!initData) throw new Error('Telegram session data is unavailable. Reopen the app from Telegram.');\n            const controller = new AbortController();\n            const timeout = setTimeout(() => controller.abort(), 15000);\n            let res;\n            try {\n              res = await fetch('/api?action=sync_user', {\n                method: 'POST', headers: {'Content-Type': 'application/json', 'Cache-Control':'no-cache'},\n                body: JSON.stringify({ initData }), signal: controller.signal, cache:'no-store'\n              });\n            } finally { clearTimeout(timeout); }\n            let data = null; try { data = await res.json(); } catch {}\n            if (!res.ok || !data?.success || !data.user || !data.settings) {\n              throw new Error(data?.message || `Server error (${res.status})`);\n            }\n            IS_ADMIN = !!data.isAdmin;\n            currentUser = data.user;\n            appSettings = data.settings;\n            dailyBonusClaimed = !!data.bonusClaimed;\n            if (data.all_users) allUsersData = data.all_users;\n            updateBasicUI();\n            if (IS_ADMIN) {\n                document.getElementById(\"admin-nav-item\")?.classList.remove(\"d-none\");\n                renderAdminPanel();\n            }\n            populateWithdrawMethods(); renderHistory(); updateTaskUI();\n        } catch (err) {\n            console.error(err);\n            showToast(err.name === 'AbortError' ? 'Server request timed out.' : (err.message || 'Failed to load user data.'), 'danger');\n            const nameEl=document.getElementById('headerUserName'); if(nameEl) nameEl.textContent='Unable to load';\n        } finally { toggleLoading(false); }\n    }\n\n    function updateBasicUI() {\n        if(!currentUser) return;\n        let fullName = `${currentUser.firstName} ${currentUser.lastName || ''}`.trim();\n        document.querySelectorAll(\".UserName\").forEach(el => el.innerText = fullName);\n        document.getElementById(\"profileUserUsername\").innerText = currentUser.username ? `@${currentUser.username}` : \"ID: \" + currentUser.id;\n        \n        const elPic1 = document.getElementById(\"headerProfilePic\");\n        const elPic2 = document.getElementById(\"profileLargeAvatar\");\n        if(currentUser.photoUrl) {\n            elPic1.innerHTML = `<img src=\"${currentUser.photoUrl}\">`;\n            elPic2.innerHTML = `<img src=\"${currentUser.photoUrl}\">`;\n        } else {\n            elPic1.innerHTML = fullName.charAt(0).toUpperCase();\n            elPic2.innerHTML = fullName.charAt(0).toUpperCase();\n        }\n\n        const balStr = formatCur(currentUser.balance);\n        document.querySelectorAll(\".user-balance\").forEach(el => el.innerText = balStr);\n        document.getElementById(\"lifetimeEarning\").innerText = formatCur(currentUser.lifetimeEarned);\n        document.getElementById(\"adsWatchedCount\").innerText = currentUser.adsWatched;\n        if(appSettings && appSettings.dailyBonusAmount) { \n            document.getElementById(\"daily-bonus-text\").innerText = `Get ${formatCur(appSettings.dailyBonusAmount)} free`; \n        }\n    }\n\n    function updateTaskUI() {\n      if(!appSettings || !currentUser) return;\n      const total = Math.max(0, parseInt(appSettings.dailyAdLimit, 10) || 0);\n      const completed = currentUser.dailyAdDate === new Date().toISOString().slice(0,10) ? Math.min(Number(currentUser.dailyAdsCount || 0), total) : 0;\n      const left = Math.max(0, total - completed);\n      const percent = total > 0 ? Math.round((completed / total) * 100) : 100;\n      document.querySelectorAll('.taskCount').forEach(e=>e.innerText=total);\n      document.querySelectorAll('.tasksCompleted').forEach(e=>e.innerText=completed);\n      document.querySelectorAll('.tasksRemaining').forEach(e=>e.innerText=left);\n      const fill=document.getElementById('progressBarFill'); if(fill) fill.style.width=`${percent}%`;\n      const pct=document.getElementById('progress-percent'); if(pct) pct.innerText=`${percent}%`;\n      const btn=document.getElementById('show-ad');\n      if(btn){ btn.disabled=left<=0; btn.innerHTML=left<=0 ? '<i class=\"bi bi-clock-fill me-2\"></i> Limit Reached for Today' : '<i class=\"bi bi-play-circle-fill me-2 fs-5 align-middle\"></i> Start Earning Task'; }\n    }\n\n    function populateWithdrawMethods() {\n      const s = document.getElementById(\"payment-method\");\n      s.innerHTML = '<option value=\"\" data-min=\"0\">Choose Method</option>';\n      if(appSettings && appSettings.withdrawMethods) {\n          let methodsStr = Array.isArray(appSettings.withdrawMethods) ? appSettings.withdrawMethods.join(\", \") : appSettings.withdrawMethods;\n          const methods = methodsStr.split(',');\n          methods.forEach(m => {\n              let parts = m.split(':');\n              let name = parts[0] ? parts[0].trim() : '';\n              let min = parts[1] ? parseFloat(parts[1].trim()) : 0;\n              if(name) { s.innerHTML += `<option value=\"${name}\" data-min=\"${min}\">${name}</option>`; }\n          });\n      }\n      updateMinLimit();\n    }\n\n    window.updateMinLimit = function() {\n        const sel = document.getElementById(\"payment-method\");\n        if(sel.selectedIndex > 0) {\n            const min = sel.options[sel.selectedIndex].getAttribute(\"data-min\");\n            document.getElementById(\"min-limit-text\").innerText = `⚠️ Minimum required: ${formatCur(min)}`;\n            document.getElementById(\"withdraw-amount\").min = min;\n        } else {\n            document.getElementById(\"min-limit-text\").innerText = '';\n        }\n    }\n\n    function renderHistory() {\n        const list = document.getElementById(\"withdraw-history-list\");\n        list.innerHTML = '';\n        const history = currentUser.withdrawHistory ||[];\n        if(history.length === 0) { list.innerHTML = '<div class=\"text-muted small text-center py-3\">No withdraw history found.</div>'; return; }\n        [...history].reverse().forEach(h => {\n            let badgeClass = 'badge-pending';\n            if(h.status === 'Completed') badgeClass = 'badge-completed';\n            else if(h.status === 'Cancelled') badgeClass = 'badge-cancelled';\n\n            list.innerHTML += `\n            <div class=\"history-item\">\n                <div>\n                    <div class=\"text-white fw-medium mb-1\">${h.method} <span class=\"text-muted small ms-1\">(${h.address})</span></div>\n                    <div class=\"text-muted small\" style=\"font-size:0.7rem\"><i class=\"bi bi-calendar2-check me-1\"></i>${h.date}</div>\n                </div>\n                <div class=\"text-end\">\n                    <div class=\"text-info fw-bold mb-1\">${formatCur(h.amount)}</div>\n                    <span class=\"${badgeClass}\">${h.status}</span>\n                </div>\n            </div>`;\n        });\n    }\n\n    function renderAdminPanel() {\n       document.getElementById(\"admin-currency\").value = appSettings.currency || 'BDT';\n       document.getElementById(\"admin-daily-bonus\").value = appSettings.dailyBonusAmount || 0;\n       document.getElementById(\"admin-ad-reward\").value = appSettings.adRewardAmount || 0;\n       document.getElementById(\"admin-block-id\").value = appSettings.adsgramBlockId || '';\n       \n       let methodsStr = Array.isArray(appSettings.withdrawMethods) ? appSettings.withdrawMethods.join(\", \") : (appSettings.withdrawMethods || '');\n       document.getElementById(\"admin-withdraw-methods\").value = methodsStr;\n       document.getElementById(\"admin-ad-limit\").value = appSettings.dailyAdLimit || 10;\n       \n       const tb = document.getElementById(\"admin-user-list\");\n       tb.innerHTML = '';\n       let allRequests =[]; // উইথড্র লিস্টের জন্য\n\n       Object.values(allUsersData).forEach(u => {\n          // ইউজার লিস্ট টেবিল\n          tb.innerHTML += `\n          <tr class=\"border-bottom border-secondary border-opacity-10\">\n            <td class=\"px-3 py-3\">\n                <div class=\"text-white fw-medium\">${u.firstName}</div>\n                <div class=\"text-muted\" style=\"font-size:0.7rem\">ID: ${u.id}</div>\n            </td>\n            <td class=\"text-center align-middle text-info\">${u.adsWatched}</td>\n            <td class=\"text-end align-middle px-3\">\n                <span class=\"text-success fw-bold d-block mb-1\">${formatCur(u.balance)}</span>\n                <button class=\"btn btn-sm btn-outline-warning py-0 px-2\" style=\"font-size:0.7rem;\" onclick=\"openEditModal('${u.id}', ${u.balance})\"><i class=\"bi bi-pencil\"></i> Edit</button>\n            </td>\n          </tr>`;\n\n          // উইথড্র ডেটা কালেক্ট\n          if(u.withdrawHistory && u.withdrawHistory.length > 0) {\n              u.withdrawHistory.forEach((req, idx) => {\n                  allRequests.push({ uid: u.id, name: u.firstName, index: idx, ...req });\n              });\n          }\n       });\n\n       // উইথড্র লিস্ট টেবিল রেন্ডার\n       const wdList = document.getElementById(\"admin-withdraw-list\");\n       wdList.innerHTML = '';\n       allRequests.reverse().forEach(req => {\n            let statusBadge = '';\n            if (req.status === 'Pending') statusBadge = '<span class=\"badge-pending\">Pending</span>';\n            else if (req.status === 'Completed') statusBadge = '<span class=\"badge-completed\">Completed</span>';\n            else if (req.status === 'Cancelled') statusBadge = '<span class=\"badge-cancelled\">Cancelled</span>';\n\n            let actionButtons = '';\n            if (req.status === 'Pending') {\n                actionButtons = `\n                <div class=\"d-flex justify-content-end gap-1 mt-1\">\n                    <button class=\"btn btn-sm btn-success py-0 px-2\" style=\"font-size:0.7rem;\" onclick=\"changeWithdrawStatus('${req.uid}', ${req.id}, 'Completed')\"><i class=\"bi bi-check2\"></i> Done</button>\n                    <button class=\"btn btn-sm btn-danger py-0 px-2\" style=\"font-size:0.7rem;\" onclick=\"changeWithdrawStatus('${req.uid}', ${req.id}, 'Cancelled')\"><i class=\"bi bi-x\"></i> Cancel</button>\n                </div>`;\n            } else {\n                 actionButtons = `<small class=\"text-muted\" style=\"font-size:0.75rem;\">Processed</small>`;\n            }\n\n            wdList.innerHTML += `\n            <tr class=\"border-bottom border-secondary border-opacity-10\">\n                <td class=\"px-3 py-3\">\n                    <div class=\"text-white fw-medium\" style=\"font-size:0.9rem;\">${req.name}</div>\n                    <div class=\"text-muted\" style=\"font-size:0.7rem\">ID: ${req.uid}</div>\n                    <div class=\"text-muted mt-1\" style=\"font-size:0.7rem\"><i class=\"bi bi-calendar2\"></i> ${req.date}</div>\n                </td>\n                <td class=\"text-center align-middle\">\n                    <div class=\"text-info fw-bold mb-1\">${formatCur(req.amount)}</div>\n                    <div class=\"text-white small\">${req.method}</div>\n                    <div class=\"text-muted\" style=\"font-size:0.75rem\">${req.address}</div>\n                    <div class=\"mt-1\">${statusBadge}</div>\n                </td>\n                <td class=\"text-end align-middle px-3\">\n                    ${actionButtons}\n                </td>\n            </tr>`;\n       });\n    }\n\n    // 🚀 NEW: Withdraw Status Update Function\n    window.changeWithdrawStatus = async function(uid, index, newStatus) {\n        if (!confirm(`Are you sure you want to mark this request as ${newStatus}?`)) return;\n        toggleLoading(true);\n        const r = await fetch('/api?action=update_withdraw_status', { \n            method: 'POST', \n            headers: {'Content-Type': 'application/json'}, \n            body: JSON.stringify({initData: telegramInitData, target_user: uid, index: index, status: newStatus}) \n        });\n        const d = await r.json();\n        if (d.success) { \n            showToast(`Status updated to ${newStatus}!`); \n            syncBackend({initData: telegramInitData}); \n        } else {\n            showToast(\"Failed to update status\", \"danger\");\n        }\n        toggleLoading(false);\n    }\n\n    window.openEditModal = function(uid, bal) {\n        document.getElementById('editUid').value = uid;\n        document.getElementById('editBalInput').value = bal;\n        document.getElementById('editModalOverlay').style.display = 'flex';\n    }\n    window.closeEditModal = function() { document.getElementById('editModalOverlay').style.display = 'none'; }\n    window.saveEditedBalance = async function() {\n        const uid = document.getElementById('editUid').value;\n        const bal = parseFloat(document.getElementById('editBalInput').value);\n        toggleLoading(true);\n        const r = await fetch('/api?action=edit_balance', { method:'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({initData: telegramInitData, target_user: uid, new_balance: bal}) });\n        const d = await r.json();\n        if(d.success) { showToast(\"Balance Updated!\"); closeEditModal(); syncBackend({initData: telegramInitData}); }\n        toggleLoading(false);\n    }\n\n    async function rewardAfterAd(type) {\n      try {\n        await loadAdsgram();\n        const blockId = String(appSettings.adsgramBlockId || '').trim();\n        if (!blockId) throw new Error('Adsgram Block ID is not configured');\n        AdController = AdController || window.Adsgram.init({blockId});\n        const result = await AdController.show();\n        if (!result?.done) throw new Error('Ad was not completed');\n        const res = await fetch('/api?action=add_reward', {\n          method:'POST', headers:{'Content-Type':'application/json'},\n          body:JSON.stringify({initData:telegramInitData,type})\n        });\n        const data = await res.json().catch(()=>null);\n        if(!res.ok || !data?.success) throw new Error(data?.message || 'Reward failed');\n        currentUser=data.user; appSettings=data.settings; dailyBonusClaimed=!!data.bonusClaimed;\n        updateBasicUI(); updateTaskUI(); renderHistory();\n        showToast(type==='ad' ? `Earned ${formatCur(appSettings.adRewardAmount)}!` : 'Bonus Claimed!','success');\n      } catch(e) { showToast(e.message || 'Ad failed','warning'); }\n    }\n\n    function loadTelegramWebApp() {\n      return new Promise((resolve, reject) => {\n        if (window.Telegram?.WebApp) return resolve(window.Telegram.WebApp);\n        const existing = document.querySelector('script[data-telegram-sdk]');\n        const finish = () => window.Telegram?.WebApp ? resolve(window.Telegram.WebApp) : reject(new Error('Telegram WebApp SDK is unavailable.'));\n        if (existing) {\n          existing.addEventListener('load', finish, {once:true});\n          existing.addEventListener('error', () => reject(new Error('Telegram SDK failed to load.')), {once:true});\n          return;\n        }\n        const s=document.createElement('script'); s.src='https://telegram.org/js/telegram-web-app.js?63'; s.async=true; s.dataset.telegramSdk='1';\n        const timer=setTimeout(() => reject(new Error('Telegram SDK load timed out. Reopen the Mini App.')), 8000);\n        s.onload=()=>{clearTimeout(timer); finish();}; s.onerror=()=>{clearTimeout(timer); reject(new Error('Telegram SDK failed to load.'));};\n        document.head.appendChild(s);\n      });\n    }\n\n    async function bootApp() {\n      try {\n        const tg = await loadTelegramWebApp();\n        tg.ready(); tg.expand();\n        telegramInitData = tg.initData || '';\n        if(!telegramInitData) throw new Error('Telegram session data is empty. Open the Mini App from the bot button.');\n        await syncBackend({initData:telegramInitData});\n      } catch(e) {\n        showToast(e.message || 'Unable to start app','danger');\n        const nameEl=document.getElementById('headerUserName'); if(nameEl) nameEl.textContent='Unable to load';\n        toggleLoading(false);\n      }\n    }\n\n    const startupWatchdog = setTimeout(() => {\n      const loader=document.getElementById('loading-spinner');\n      if(loader && !loader.classList.contains('d-none')) {\n        toggleLoading(false);\n        showToast('App startup took too long. Please reopen it from Telegram.','danger');\n      }\n    }, 20000);\n\n    document.addEventListener(\"DOMContentLoaded\", () => {\n      document.getElementById(\"show-ad\")?.addEventListener(\"click\", async () => { toggleLoading(true); try { await rewardAfterAd('ad'); } finally { toggleLoading(false); } });\n      document.getElementById(\"claim-daily-bonus\")?.addEventListener(\"click\", async () => {\n        if(dailyBonusClaimed) return showToast('You already claimed today!','warning');\n        toggleLoading(true); try { await rewardAfterAd('bonus'); } finally { toggleLoading(false); }\n      });\n      document.getElementById(\"payment-method\")?.addEventListener('change', updateMinLimit);\n      document.getElementById(\"submitWithdrawBtn\")?.addEventListener(\"click\", async () => {\n        const amt = Number(document.getElementById(\"withdraw-amount\").value), sel=document.getElementById(\"payment-method\"), method=sel.value, addr=document.getElementById(\"withdraw-address\").value.trim();\n        const minLimit=Number(sel.options[sel.selectedIndex]?.getAttribute('data-min') || 0);\n        if(!Number.isFinite(amt) || amt<=0 || !method || !addr) return showToast('Please fill all required fields','warning');\n        if(amt<minLimit) return showToast(`Minimum limit for ${method} is ${formatCur(minLimit)}`,'danger');\n        if(amt>Number(currentUser.balance||0)) return showToast('Insufficient balance!','danger');\n        toggleLoading(true);\n        try {\n          const r=await fetch('/api?action=withdraw',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:telegramInitData,amount:amt,method,address:addr})});\n          const d=await r.json().catch(()=>null); if(!r.ok||!d?.success) throw new Error(d?.message||'Withdrawal failed');\n          currentUser=d.user; appSettings=d.settings; updateBasicUI(); renderHistory(); document.getElementById('withdraw-form').reset(); updateMinLimit(); showToast('Withdraw Request Sent!','success');\n        } catch(e){ showToast(e.message||'Withdrawal failed','danger'); } finally { toggleLoading(false); }\n      });\n      document.getElementById(\"saveAdminSettingsBtn\")?.addEventListener(\"click\", async () => {\n        const newSet={currency:document.getElementById('admin-currency').value.trim()||'BDT',dailyBonusAmount:Number(document.getElementById('admin-daily-bonus').value),adRewardAmount:Number(document.getElementById('admin-ad-reward').value),adsgramBlockId:document.getElementById('admin-block-id').value.trim(),withdrawMethods:document.getElementById('admin-withdraw-methods').value.trim(),dailyAdLimit:Number(document.getElementById('admin-ad-limit').value)};\n        toggleLoading(true); try { const r=await fetch('/api?action=update_settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:telegramInitData,settings:newSet})}); const d=await r.json().catch(()=>null); if(!r.ok||!d?.success) throw new Error(d?.message||'Settings update failed'); appSettings=d.settings; populateWithdrawMethods(); updateBasicUI(); updateTaskUI(); renderAdminPanel(); showToast('Settings saved successfully!','success'); } catch(e){showToast(e.message||'Settings update failed','danger')} finally{toggleLoading(false)}\n      });\n      bootApp();\n    });\n\n    window.showSection = function(id) {\n      document.querySelectorAll(\"main > section\").forEach(s => s.classList.add(\"d-none\"));\n      document.getElementById(id).classList.remove(\"d-none\");\n      document.querySelectorAll('.app-bottom-nav .nav-item').forEach(n => n.classList.remove('active'));\n      const activeNav = Array.from(document.querySelectorAll('.app-bottom-nav .nav-item')).find(nav => nav.getAttribute('data-section') === id);\n      if (activeNav) activeNav.classList.add('active');\n    }\n  </script>\n</body>\n</html>";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/telegram") return handleTelegramWebhook(request, env);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    if (request.method === "GET") {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return json({ success: false, message: "Not found" }, 404);
  }
};
