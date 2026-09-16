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
      INSERT INTO users(id, firstName, lastName, username, photoUrl, balance, adsWatched, lifetimeEarned, lastBonusDate)
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
  if (!env.BOT_TOKEN || !env.ADMIN_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.ADMIN_CHAT_ID, text, parse_mode: "Markdown" })
  });
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

      const updated = await env.DB.prepare(
        "UPDATE users SET balance=balance-? WHERE id=? AND balance>=?"
      ).bind(amount, String(auth.user.id), amount).run();
      if (!updated.meta.changes) return json({ success: false, message: "Insufficient balance" }, 400);

      await env.DB.prepare(
        "INSERT INTO withdrawals(user_id, amount, method, address, status, created_at) VALUES(?,?,?,?,?,?)"
      ).bind(String(auth.user.id), amount, method, address, "Pending", new Date().toISOString()).run();

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
      const settings = {
        ...old,
        currency: String(incoming.currency || old.currency),
        dailyBonusAmount: Number(incoming.dailyBonusAmount ?? old.dailyBonusAmount),
        adRewardAmount: Number(incoming.adRewardAmount ?? old.adRewardAmount),
        adsgramBlockId: String(incoming.adsgramBlockId ?? old.adsgramBlockId),
        withdrawMethods: String(incoming.withdrawMethods ?? old.withdrawMethods),
        dailyAdLimit: Number(incoming.dailyAdLimit ?? old.dailyAdLimit)
      };
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

      if (req.status === "Pending" && newStatus === "Cancelled") {
        await env.DB.batch([
          env.DB.prepare("UPDATE withdrawals SET status=? WHERE id=?").bind(newStatus, id),
          env.DB.prepare("UPDATE users SET balance=balance+? WHERE id=?").bind(Number(req.amount), target)
        ]);
      } else {
        await env.DB.prepare("UPDATE withdrawals SET status=? WHERE id=? AND status='Pending'").bind(newStatus, id).run();
      }
      return json({ success: true });
    }

    return json({ success: false, message: "Unknown action" }, 404);
  } catch (err) {
    console.error(err);
    return json({ success: false, message: err.message || "Server error" }, 500);
  }
}

const HTML = "\n\n<!-- =========================== HTML FRONTEND =========================== -->\n<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\" />\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0\" />\n  <title>Premium Task App</title>\n  \n  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n  <link href=\"https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap\" rel=\"stylesheet\">\n  <link href=\"https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css\" rel=\"stylesheet\" crossorigin=\"anonymous\" />\n  <link href=\"https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.css\" rel=\"stylesheet\">\n  <script src=\"https://sad.adsgram.ai/js/sad.min.js\"></script>\n  \n  <style>\n    :root { \n        --bg-body: #050b14; \n        --bg-surface: rgba(16, 25, 43, 0.6); \n        --bg-surface-light: rgba(26, 38, 65, 0.8); \n        --border-color: rgba(255, 255, 255, 0.08); \n        --accent-primary: #00d2ff; \n        --accent-secondary: #3a7bd5; \n        --accent-success: #00f260; \n        --accent-warning: #f7b733; \n        --accent-danger: #fc4a1a; \n        --text-main: #ffffff; \n        --text-muted: #a0aec0; \n    }\n    body { background-color: var(--bg-body); background-image: radial-gradient(circle at top right, rgba(58,123,213,0.15), transparent 400px), radial-gradient(circle at bottom left, rgba(0,210,255,0.1), transparent 400px); color: var(--text-main); font-family: 'Outfit', sans-serif; padding-bottom: 110px; min-height: 100vh; }\n    \n    .text-muted { color: var(--text-muted) !important; }\n    .text-secondary { color: #cbd5e1 !important; }\n    \n    .premium-card { background: var(--bg-surface-light); backdrop-filter: blur(16px); border: 1px solid var(--border-color); border-radius: 20px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3); transition: transform 0.3s ease; }\n    \n    .premium-input { background: rgba(0, 0, 0, 0.25) !important; border: 1px solid rgba(255, 255, 255, 0.15) !important; color: white !important; border-radius: 14px; padding: 14px 18px; }\n    .premium-input:focus { border-color: var(--accent-primary) !important; box-shadow: 0 0 0 3px rgba(0, 210, 255, 0.2) !important; }\n    .premium-input::placeholder { color: rgba(255, 255, 255, 0.4) !important; }\n    \n    .btn-primary-custom { background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); color: #fff; border: none; border-radius: 14px; padding: 16px 24px; font-weight: 600; box-shadow: 0 6px 20px rgba(58, 123, 213, 0.4); transition: 0.3s; }\n    .btn-primary-custom:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }\n    .btn-outline-custom { background: transparent; color: var(--accent-primary); border: 2px solid var(--accent-primary); border-radius: 12px; padding: 10px 20px; font-weight: 600; transition: 0.3s; }\n    \n    .top-nav { background: rgba(5, 11, 20, 0.85); backdrop-filter: blur(20px); border-bottom: 1px solid var(--border-color); padding: 15px 0; position: sticky; top: 0; z-index: 1000; }\n    .profile-pic { width: 50px; height: 50px; object-fit: cover; border-radius: 50%; border: 2px solid var(--accent-primary); background: #1a2641; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1.3rem; color: var(--accent-primary); padding: 2px; }\n    .profile-pic img { border-radius: 50%; width: 100%; height: 100%; object-fit: cover; }\n    \n    .metric-box { background: rgba(0,0,0,0.3); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 16px; padding: 15px; text-align: center; }\n    .progress-slim { height: 8px; background-color: rgba(255,255,255,0.1); border-radius: 10px; overflow: hidden; }\n    .progress-slim .progress-bar { background: linear-gradient(90deg, var(--accent-secondary), var(--accent-primary)); }\n    \n    .app-bottom-nav { position: fixed; bottom: 0; left: 0; right: 0; background: rgba(16, 25, 43, 0.95); backdrop-filter: blur(25px); border-top: 1px solid var(--border-color); display: flex; justify-content: space-around; align-items: center; height: 85px; z-index: 999; border-radius: 30px 30px 0 0; }\n    .nav-item { text-decoration: none; display: flex; flex-direction: column; align-items: center; color: var(--text-muted); font-size: 0.85rem; flex: 1; cursor: pointer; transition: 0.3s; }\n    .nav-item i { font-size: 1.5rem; margin-bottom: 4px; transition: 0.3s; }\n    .nav-item.active { color: var(--accent-primary); font-weight: 600; }\n    .nav-item.active i { transform: translateY(-4px); text-shadow: 0 0 15px var(--accent-primary); }\n    \n    .chip { background: rgba(0, 210, 255, 0.1); border: 1px solid rgba(0, 210, 255, 0.3); padding: 6px 14px; border-radius: 30px; font-size: 0.9rem; display: inline-flex; align-items: center; gap: 8px; color: var(--accent-primary); font-weight: 600;}\n    \n    .history-item { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); padding: 12px; border-radius: 12px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }\n    .badge-pending { background: rgba(247, 183, 51, 0.15); color: var(--accent-warning); padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; border: 1px solid rgba(247, 183, 51, 0.3); }\n    .badge-completed { background: rgba(0, 242, 96, 0.15); color: var(--accent-success); padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; border: 1px solid rgba(0, 242, 96, 0.3); }\n    .badge-cancelled { background: rgba(252, 74, 26, 0.15); color: var(--accent-danger); padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; border: 1px solid rgba(252, 74, 26, 0.3); }\n\n    .toast-area { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 5000; width: 90%; max-width: 350px; }\n    .toast-pop { background: var(--bg-surface-light); backdrop-filter: blur(20px); border: 1px solid var(--border-color); border-radius: 16px; padding: 15px; display: flex; align-items: center; gap: 12px; opacity: 0; transition: 0.3s ease; box-shadow: 0 10px 30px rgba(0,0,0,0.5); margin-bottom: 10px; }\n    .toast-pop.success i { color: var(--accent-success); } .toast-pop.danger i { color: var(--accent-danger); } .toast-pop.warning i { color: var(--accent-warning); }\n\n    .loading-spinner { background: var(--bg-body); z-index: 9999; }\n    \n    .custom-modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); backdrop-filter: blur(5px); z-index: 6000; display: none; align-items: center; justify-content: center; }\n    .custom-modal { background: var(--bg-surface-light); border: 1px solid var(--border-color); border-radius: 20px; padding: 25px; width: 90%; max-width: 350px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }\n  </style>\n</head>\n<body>\n\n  <!-- Loading Spinner -->\n  <div class=\"loading-spinner position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center\" id=\"loading-spinner\">\n    <div class=\"spinner-border text-info\" style=\"width: 3rem; height: 3rem;\" role=\"status\"></div>\n  </div>\n\n  <!-- Edit Balance Modal -->\n  <div class=\"custom-modal-overlay\" id=\"editModalOverlay\">\n    <div class=\"custom-modal\">\n        <h5 class=\"text-white mb-3\">Edit User Balance</h5>\n        <input type=\"hidden\" id=\"editUid\">\n        <div class=\"mb-3\">\n            <label class=\"text-muted small mb-1\">New Balance</label>\n            <input type=\"number\" step=\"0.01\" id=\"editBalInput\" class=\"form-control premium-input\">\n        </div>\n        <div class=\"d-flex gap-2\">\n            <button class=\"btn btn-secondary w-50 rounded-3\" onclick=\"closeEditModal()\">Cancel</button>\n            <button class=\"btn btn-info w-50 rounded-3 text-dark fw-bold\" onclick=\"saveEditedBalance()\">Save</button>\n        </div>\n    </div>\n  </div>\n\n  <nav class=\"top-nav shadow-sm\">\n    <div class=\"container d-flex align-items-center justify-content-between\">\n      <div class=\"d-flex align-items-center gap-3\">\n        <div class=\"profile-pic\" id=\"headerProfilePic\"><i class=\"bi bi-person\"></i></div>\n        <div class=\"lh-1\">\n          <div class=\"text-muted small mb-1\">Hello, Tasker</div>\n          <h6 class=\"mb-0 fw-bold text-white UserName\" id=\"headerUserName\">Loading...</h6>\n        </div>\n      </div>\n      <div>\n        <div class=\"chip\">\n          <i class=\"bi bi-wallet2\"></i> <span class=\"user-balance\" id=\"globalBalance\">0.00</span>\n        </div>\n      </div>\n    </div>\n  </nav>\n\n  <main class=\"container py-4\">\n    <!-- HOME SECTION -->\n    <section id=\"home\">\n      <div class=\"premium-card p-4 mb-4 text-center\" style=\"background: linear-gradient(145deg, rgba(26, 38, 65, 0.9), rgba(16, 25, 43, 0.9));\">\n        <h6 class=\"text-muted fw-medium mb-1\">Total Available Balance</h6>\n        <h1 class=\"fw-bold mb-0 text-white user-balance display-4\" id=\"homeBalance\">0.00</h1>\n      </div>\n\n      <div class=\"premium-card p-3 mb-4 d-flex justify-content-between align-items-center\">\n        <div class=\"d-flex align-items-center gap-3\">\n          <div class=\"bg-warning bg-opacity-10 p-2 rounded-circle text-warning fs-3 lh-1\"><i class=\"bi bi-gift\"></i></div>\n          <div>\n            <h6 class=\"text-white fw-bold mb-0\">Daily Bonus</h6>\n            <small class=\"text-muted\" id=\"daily-bonus-text\">Get free cash daily</small>\n          </div>\n        </div>\n        <button id=\"claim-daily-bonus\" class=\"btn btn-sm btn-outline-custom\">Claim</button>\n      </div> \n\n      <div class=\"row g-2 mb-4\">\n        <div class=\"col-4\"><div class=\"metric-box\"><i class=\"bi bi-bullseye text-info fs-4 d-block mb-1\"></i><small class=\"text-muted d-block\">Limit</small><strong class=\"fs-5 text-white taskCount\">0</strong></div></div>\n        <div class=\"col-4\"><div class=\"metric-box\"><i class=\"bi bi-check2-circle text-success fs-4 d-block mb-1\"></i><small class=\"text-muted d-block\">Done</small><strong class=\"fs-5 text-white tasksCompleted\">0</strong></div></div>\n        <div class=\"col-4\"><div class=\"metric-box\"><i class=\"bi bi-clock-history text-warning fs-4 d-block mb-1\"></i><small class=\"text-muted d-block\">Left</small><strong class=\"fs-5 text-white tasksRemaining\">0</strong></div></div>\n      </div>\n\n      <div class=\"premium-card p-4\">\n        <div class=\"d-flex justify-content-between small text-muted mb-2\">\n            <span>Today's Target</span>\n            <span id=\"progress-percent\">0%</span>\n        </div>\n        <div class=\"progress progress-slim mb-4\">\n          <div class=\"progress-bar\" id=\"progressBarFill\" style=\"width: 0%\"></div>\n        </div>\n        <button id=\"show-ad\" class=\"btn btn-primary-custom w-100 fs-5\">\n          <i class=\"bi bi-play-circle me-2\"></i> Start Earning Task\n        </button>\n      </div>\n    </section>\n\n    <!-- WITHDRAW SECTION -->\n    <section class=\"d-none\" id=\"withdraw\">\n      <div class=\"premium-card p-4 mb-4 text-center\">\n        <i class=\"bi bi-bank text-info display-4 mb-2 d-block\"></i>\n        <h4 class=\"fw-bold text-white mb-1\">Withdraw Funds</h4>\n        <p class=\"text-muted mb-0\">Current: <span class=\"user-balance fw-bold text-white\">0.00</span></p>\n      </div>\n      \n      <div class=\"premium-card p-4\">\n        <form id=\"withdraw-form\">\n          <div class=\"mb-3\">\n            <label class=\"text-muted small mb-1\">Select Payment Method</label>\n            <select class=\"form-select premium-input\" id=\"payment-method\" required onchange=\"updateMinLimit()\"></select>\n            <small class=\"text-info mt-1 d-block\" id=\"min-limit-text\"></small>\n          </div>\n          <div class=\"mb-3\">\n            <label class=\"text-muted small mb-1\">Amount</label>\n            <input type=\"number\" step=\"0.01\" class=\"form-control premium-input\" id=\"withdraw-amount\" placeholder=\"Enter amount\" required />\n          </div>\n          <div class=\"mb-4\">\n            <label class=\"text-muted small mb-1\">Account Number / Address</label>\n            <input type=\"text\" class=\"form-control premium-input\" id=\"withdraw-address\" placeholder=\"Enter details...\" required />\n          </div>\n          <button type=\"button\" class=\"btn btn-primary-custom w-100\" id=\"submitWithdrawBtn\">Submit Request</button>\n        </form>\n      </div>\n    </section>\n\n    <!-- PROFILE SECTION -->\n    <section class=\"d-none\" id=\"profile\">\n      <div class=\"premium-card p-4 text-center mb-4\">\n        <div class=\"profile-pic mx-auto mb-3\" id=\"profileLargeAvatar\" style=\"width: 80px; height: 80px; font-size: 2rem;\"><i class=\"bi bi-person\"></i></div>\n        <h5 class=\"text-white fw-bold mb-0 UserName\">Loading...</h5>\n        <div class=\"text-muted small mb-3\" id=\"profileUserUsername\">@user</div>\n        \n        <div class=\"row g-2 text-start\">\n            <div class=\"col-6\"><div class=\"bg-dark bg-opacity-50 p-3 rounded-4 border border-secondary border-opacity-25\"><small class=\"text-muted d-block\">Total Earned</small><strong class=\"text-success fs-5\" id=\"lifetimeEarning\">0.00</strong></div></div>\n            <div class=\"col-6\"><div class=\"bg-dark bg-opacity-50 p-3 rounded-4 border border-secondary border-opacity-25\"><small class=\"text-muted d-block\">Ads Watched</small><strong class=\"text-info fs-5\" id=\"adsWatchedCount\">0</strong></div></div>\n        </div>\n      </div>\n\n      <h6 class=\"text-muted mb-3 px-2\"><i class=\"bi bi-clock-history me-2\"></i>Withdraw History</h6>\n      <div id=\"withdraw-history-list\"></div>\n    </section>\n\n    <!-- ADMIN PANEL SECTION -->\n    <section class=\"d-none\" id=\"admin-panel\">\n      <div class=\"premium-card p-4 mb-4 text-center border-danger border-opacity-50\">\n        <i class=\"bi bi-shield-lock text-danger display-5 mb-2 d-block\"></i>\n        <h4 class=\"fw-bold text-white mb-0\">Admin Access</h4>\n      </div>\n\n      <div class=\"premium-card p-4 mb-4\">\n        <h6 class=\"text-white mb-3\"><i class=\"bi bi-sliders me-2 text-info\"></i> App Configuration</h6>\n        <form id=\"admin-settings-form\">\n          <div class=\"row g-3 mb-3\">\n            <div class=\"col-12\">\n              <label class=\"text-muted small mb-1\">App Currency (e.g., BDT, ৳, USDT, $)</label>\n              <input type=\"text\" class=\"form-control premium-input border-info\" id=\"admin-currency\" placeholder=\"BDT\" />\n            </div>\n            <div class=\"col-6\">\n              <label class=\"text-muted small mb-1\">Daily Bonus</label>\n              <input type=\"number\" step=\"0.01\" class=\"form-control premium-input\" id=\"admin-daily-bonus\" />\n            </div>\n            <div class=\"col-6\">\n              <label class=\"text-muted small mb-1\">Ad Reward</label>\n              <input type=\"number\" step=\"0.01\" class=\"form-control premium-input\" id=\"admin-ad-reward\" />\n            </div>\n          </div>\n          <div class=\"mb-3\">\n            <label class=\"text-muted small mb-1\">Adsgram Block ID</label>\n            <input type=\"text\" class=\"form-control premium-input border-warning\" id=\"admin-block-id\" placeholder=\"e.g. 28773\"/>\n          </div>\n          <div class=\"mb-3\">\n            <label class=\"text-muted small mb-1\">Withdraw Methods (Method:MinLimit)</label>\n            <input type=\"text\" class=\"form-control premium-input\" id=\"admin-withdraw-methods\" placeholder=\"bKash:200, Nagad:150\" />\n            <small class=\"text-muted mt-1\">Example: bKash:200, Nagad:200, Binance:5</small>\n          </div>\n          <div class=\"mb-3\">\n            <label class=\"text-muted small mb-1\">Daily Ad Limit</label>\n            <input type=\"number\" class=\"form-control premium-input\" id=\"admin-ad-limit\" />\n          </div>\n          <div class=\"mb-4\">\n            <label class=\"text-muted small mb-1\">Telegram Bot Token (For alerts)</label>\n            <input type=\"text\" class=\"form-control premium-input\" id=\"admin-bot-token\" />\n          </div>\n          <button type=\"button\" class=\"btn btn-danger w-100 fw-bold rounded-3 py-3\" id=\"saveAdminSettingsBtn\">Save All Configurations</button>\n        </form>\n      </div>\n\n      <div class=\"premium-card p-0 mb-4 overflow-hidden\">\n        <div class=\"p-3 border-bottom border-secondary border-opacity-25 bg-dark bg-opacity-50\">\n            <h6 class=\"text-white mb-0\"><i class=\"bi bi-people me-2 text-success\"></i> Users Management</h6>\n        </div>\n        <div class=\"table-responsive\">\n          <table class=\"table table-borderless table-hover align-middle mb-0 text-white\">\n            <thead class=\"bg-dark bg-opacity-50 text-muted small\">\n              <tr>\n                <th class=\"py-3 px-3\">User</th>\n                <th class=\"py-3 text-center\">Ads</th>\n                <th class=\"py-3 text-end px-3\">Balance / Edit</th>\n              </tr>\n            </thead>\n            <tbody id=\"admin-user-list\"></tbody>\n          </table>\n        </div>\n      </div>\n\n      <!-- Withdraw Requests Management -->\n      <div class=\"premium-card p-0 mb-4 overflow-hidden\">\n        <div class=\"p-3 border-bottom border-secondary border-opacity-25 bg-dark bg-opacity-50\">\n            <h6 class=\"text-white mb-0\"><i class=\"bi bi-cash-coin me-2 text-warning\"></i> Withdraw Requests</h6>\n        </div>\n        <div class=\"table-responsive\">\n          <table class=\"table table-borderless table-hover align-middle mb-0 text-white\">\n            <thead class=\"bg-dark bg-opacity-50 text-muted small\">\n              <tr>\n                <th class=\"py-3 px-3\">User Details</th>\n                <th class=\"py-3 text-center\">Amount & Info</th>\n                <th class=\"py-3 text-end px-3\">Action</th>\n              </tr>\n            </thead>\n            <tbody id=\"admin-withdraw-list\"></tbody>\n          </table>\n        </div>\n      </div>\n    </section>\n  </main>\n\n  <footer class=\"app-bottom-nav shadow-lg\">\n    <div onclick=\"showSection('profile')\" class=\"nav-item\" data-section=\"profile\"><i class=\"bi bi-person-badge\"></i><span>Profile</span></div>\n    <div onclick=\"showSection('home')\" class=\"nav-item active\" data-section=\"home\"><i class=\"bi bi-house-door\"></i><span>Home</span></div>\n    <div onclick=\"showSection('withdraw')\" class=\"nav-item\" data-section=\"withdraw\"><i class=\"bi bi-wallet2\"></i><span>Withdraw</span></div>\n    <div onclick=\"showSection('admin-panel')\" class=\"nav-item d-none\" id=\"admin-nav-item\" data-section=\"admin-panel\"><i class=\"bi bi-shield-check\"></i><span>Admin</span></div>\n  </footer>\n\n  <div id=\"toast-area\" class=\"toast-area\"></div>\n\n  <script src=\"https://telegram.org/js/telegram-web-app.js\"></script>\n\n  <script>\n    let IS_ADMIN = false;\\n    let telegramInitData = \"\";\n    \n    let currentUser = { id: \"guest\", firstName: \"Loading\", balance: 0, adsWatched: 0, lifetimeEarned: 0, withdrawHistory:[] };\n    let appSettings = {};\n    let allUsersData = {};\n    let dailyBonusClaimed = false;\n    let AdController = null;\n\n    function toggleLoading(show) { \n        const loader = document.getElementById(\"loading-spinner\");\n        if(show) {\n            loader.classList.remove(\"d-none\"); loader.classList.add(\"d-flex\");\n        } else {\n            loader.classList.remove(\"d-flex\"); loader.classList.add(\"d-none\");\n        }\n    }\n    \n    function showToast(msg, type = \"success\") {\n      const area = document.getElementById(\"toast-area\");\n      const icon = type === 'success' ? 'bi-check-circle-fill' : type === 'danger' ? 'bi-exclamation-octagon-fill' : 'bi-info-circle-fill';\n      const t = document.createElement(\"div\"); t.className = `toast-pop ${type}`;\n      t.innerHTML = `<i class=\"bi ${icon} fs-3\"></i> <div><strong class=\"d-block text-capitalize text-white mb-1\">${type}</strong><span class=\"small text-light\">${msg}</span></div>`;\n      area.appendChild(t); \n      setTimeout(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; }, 10);\n      setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);\n    }\n\n    function formatCur(amount) {\n        let cur = appSettings.currency || 'BDT';\n        return parseFloat(amount || 0).toFixed(2) + ' ' + cur;\n    }\n\n    async function syncBackend(tgUser) {\n        toggleLoading(true);\n        try {\n            const res = await fetch('/api?action=sync_user', { \n                method: 'POST', \n                headers: {'Content-Type': 'application/json'},\n                body: JSON.stringify({ initData: tgUser.initData || telegramInitData })\n            });\n            const data = await res.json();\n            \n            currentUser = data.user;\n            appSettings = data.settings;\n            dailyBonusClaimed = data.bonusClaimed;\n            if (data.all_users) allUsersData = data.all_users;\n            \n            if(window.Adsgram && appSettings.adsgramBlockId) {\n                AdController = window.Adsgram.init({ blockId: appSettings.adsgramBlockId.toString().trim() });\n            }\n            \n            updateBasicUI();\n            \n            if (IS_ADMIN) {\n                document.getElementById(\"admin-nav-item\").classList.remove(\"d-none\");\n                renderAdminPanel();\n            }\n\n            populateWithdrawMethods();\n            renderHistory();\n            updateTaskUI();\n        } catch (err) { \n            console.error(err); \n            showToast(\"Failed to load user data.\", \"danger\"); \n        } finally {\n            toggleLoading(false);\n        }\n    }\n\n    function updateBasicUI() {\n        if(!currentUser) return;\n        let fullName = `${currentUser.firstName} ${currentUser.lastName || ''}`.trim();\n        document.querySelectorAll(\".UserName\").forEach(el => el.innerText = fullName);\n        document.getElementById(\"profileUserUsername\").innerText = currentUser.username ? `@${currentUser.username}` : \"ID: \" + currentUser.id;\n        \n        const elPic1 = document.getElementById(\"headerProfilePic\");\n        const elPic2 = document.getElementById(\"profileLargeAvatar\");\n        if(currentUser.photoUrl) {\n            elPic1.innerHTML = `<img src=\"${currentUser.photoUrl}\">`;\n            elPic2.innerHTML = `<img src=\"${currentUser.photoUrl}\">`;\n        } else {\n            elPic1.innerHTML = fullName.charAt(0).toUpperCase();\n            elPic2.innerHTML = fullName.charAt(0).toUpperCase();\n        }\n\n        const balStr = formatCur(currentUser.balance);\n        document.querySelectorAll(\".user-balance\").forEach(el => el.innerText = balStr);\n        document.getElementById(\"lifetimeEarning\").innerText = formatCur(currentUser.lifetimeEarned);\n        document.getElementById(\"adsWatchedCount\").innerText = currentUser.adsWatched;\n        if(appSettings && appSettings.dailyBonusAmount) { \n            document.getElementById(\"daily-bonus-text\").innerText = `Get ${formatCur(appSettings.dailyBonusAmount)} free`; \n        }\n    }\n\n    function updateTaskUI() {\n      if(!appSettings) return;\n      let total = parseInt(appSettings.dailyAdLimit) || 10;\n      let completed = currentUser.adsWatched % (total + 1);\n      if(completed > total) completed = total;\n      let left = total - completed;\n      let percent = Math.round((completed / total) * 100);\n      \n      document.querySelectorAll(\".taskCount\").forEach(e=>e.innerText=total);\n      document.querySelectorAll(\".tasksCompleted\").forEach(e=>e.innerText=completed);\n      document.querySelectorAll(\".tasksRemaining\").forEach(e=>e.innerText=left);\n      \n      document.getElementById(\"progressBarFill\").style.width = `${percent}%`;\n      document.getElementById(\"progress-percent\").innerText = `${percent}%`;\n      \n      const btn = document.getElementById(\"show-ad\");\n      if (left <= 0) { \n          btn.disabled = true; btn.innerHTML = '<i class=\"bi bi-clock-fill me-2\"></i> Limit Reached for Today'; \n      } else { \n          btn.disabled = false; btn.innerHTML = '<i class=\"bi bi-play-circle-fill me-2 fs-5 align-middle\"></i> Start Earning Task'; \n      }\n    }\n\n    function populateWithdrawMethods() {\n      const s = document.getElementById(\"payment-method\");\n      s.innerHTML = '<option value=\"\" data-min=\"0\">Choose Method</option>';\n      if(appSettings && appSettings.withdrawMethods) {\n          let methodsStr = Array.isArray(appSettings.withdrawMethods) ? appSettings.withdrawMethods.join(\", \") : appSettings.withdrawMethods;\n          const methods = methodsStr.split(',');\n          methods.forEach(m => {\n              let parts = m.split(':');\n              let name = parts[0] ? parts[0].trim() : '';\n              let min = parts[1] ? parseFloat(parts[1].trim()) : 0;\n              if(name) { s.innerHTML += `<option value=\"${name}\" data-min=\"${min}\">${name}</option>`; }\n          });\n      }\n      updateMinLimit();\n    }\n\n    window.updateMinLimit = function() {\n        const sel = document.getElementById(\"payment-method\");\n        if(sel.selectedIndex > 0) {\n            const min = sel.options[sel.selectedIndex].getAttribute(\"data-min\");\n            document.getElementById(\"min-limit-text\").innerText = `⚠️ Minimum required: ${formatCur(min)}`;\n            document.getElementById(\"withdraw-amount\").min = min;\n        } else {\n            document.getElementById(\"min-limit-text\").innerText = '';\n        }\n    }\n\n    function renderHistory() {\n        const list = document.getElementById(\"withdraw-history-list\");\n        list.innerHTML = '';\n        const history = currentUser.withdrawHistory ||[];\n        if(history.length === 0) { list.innerHTML = '<div class=\"text-muted small text-center py-3\">No withdraw history found.</div>'; return; }\n        [...history].reverse().forEach(h => {\n            let badgeClass = 'badge-pending';\n            if(h.status === 'Completed') badgeClass = 'badge-completed';\n            else if(h.status === 'Cancelled') badgeClass = 'badge-cancelled';\n\n            list.innerHTML += `\n            <div class=\"history-item\">\n                <div>\n                    <div class=\"text-white fw-medium mb-1\">${h.method} <span class=\"text-muted small ms-1\">(${h.address})</span></div>\n                    <div class=\"text-muted small\" style=\"font-size:0.7rem\"><i class=\"bi bi-calendar2-check me-1\"></i>${h.date}</div>\n                </div>\n                <div class=\"text-end\">\n                    <div class=\"text-info fw-bold mb-1\">${formatCur(h.amount)}</div>\n                    <span class=\"${badgeClass}\">${h.status}</span>\n                </div>\n            </div>`;\n        });\n    }\n\n    function renderAdminPanel() {\n       document.getElementById(\"admin-currency\").value = appSettings.currency || 'BDT';\n       document.getElementById(\"admin-daily-bonus\").value = appSettings.dailyBonusAmount || 0;\n       document.getElementById(\"admin-ad-reward\").value = appSettings.adRewardAmount || 0;\n       document.getElementById(\"admin-block-id\").value = appSettings.adsgramBlockId || '';\n       \n       let methodsStr = Array.isArray(appSettings.withdrawMethods) ? appSettings.withdrawMethods.join(\", \") : (appSettings.withdrawMethods || '');\n       document.getElementById(\"admin-withdraw-methods\").value = methodsStr;\n       document.getElementById(\"admin-ad-limit\").value = appSettings.dailyAdLimit || 10;\n       document.getElementById(\"admin-bot-token\").value = appSettings.botToken || '';\n       \n       const tb = document.getElementById(\"admin-user-list\");\n       tb.innerHTML = '';\n       let allRequests =[]; // উইথড্র লিস্টের জন্য\n\n       Object.values(allUsersData).forEach(u => {\n          // ইউজার লিস্ট টেবিল\n          tb.innerHTML += `\n          <tr class=\"border-bottom border-secondary border-opacity-10\">\n            <td class=\"px-3 py-3\">\n                <div class=\"text-white fw-medium\">${u.firstName}</div>\n                <div class=\"text-muted\" style=\"font-size:0.7rem\">ID: ${u.id}</div>\n            </td>\n            <td class=\"text-center align-middle text-info\">${u.adsWatched}</td>\n            <td class=\"text-end align-middle px-3\">\n                <span class=\"text-success fw-bold d-block mb-1\">${formatCur(u.balance)}</span>\n                <button class=\"btn btn-sm btn-outline-warning py-0 px-2\" style=\"font-size:0.7rem;\" onclick=\"openEditModal('${u.id}', ${u.balance})\"><i class=\"bi bi-pencil\"></i> Edit</button>\n            </td>\n          </tr>`;\n\n          // উইথড্র ডেটা কালেক্ট\n          if(u.withdrawHistory && u.withdrawHistory.length > 0) {\n              u.withdrawHistory.forEach((req, idx) => {\n                  allRequests.push({ uid: u.id, name: u.firstName, index: idx, ...req });\n              });\n          }\n       });\n\n       // উইথড্র লিস্ট টেবিল রেন্ডার\n       const wdList = document.getElementById(\"admin-withdraw-list\");\n       wdList.innerHTML = '';\n       allRequests.reverse().forEach(req => {\n            let statusBadge = '';\n            if (req.status === 'Pending') statusBadge = '<span class=\"badge-pending\">Pending</span>';\n            else if (req.status === 'Completed') statusBadge = '<span class=\"badge-completed\">Completed</span>';\n            else if (req.status === 'Cancelled') statusBadge = '<span class=\"badge-cancelled\">Cancelled</span>';\n\n            let actionButtons = '';\n            if (req.status === 'Pending') {\n                actionButtons = `\n                <div class=\"d-flex justify-content-end gap-1 mt-1\">\n                    <button class=\"btn btn-sm btn-success py-0 px-2\" style=\"font-size:0.7rem;\" onclick=\"changeWithdrawStatus('${req.uid}', ${req.id}, 'Completed')\"><i class=\"bi bi-check2\"></i> Done</button>\n                    <button class=\"btn btn-sm btn-danger py-0 px-2\" style=\"font-size:0.7rem;\" onclick=\"changeWithdrawStatus('${req.uid}', ${req.id}, 'Cancelled')\"><i class=\"bi bi-x\"></i> Cancel</button>\n                </div>`;\n            } else {\n                 actionButtons = `<small class=\"text-muted\" style=\"font-size:0.75rem;\">Processed</small>`;\n            }\n\n            wdList.innerHTML += `\n            <tr class=\"border-bottom border-secondary border-opacity-10\">\n                <td class=\"px-3 py-3\">\n                    <div class=\"text-white fw-medium\" style=\"font-size:0.9rem;\">${req.name}</div>\n                    <div class=\"text-muted\" style=\"font-size:0.7rem\">ID: ${req.uid}</div>\n                    <div class=\"text-muted mt-1\" style=\"font-size:0.7rem\"><i class=\"bi bi-calendar2\"></i> ${req.date}</div>\n                </td>\n                <td class=\"text-center align-middle\">\n                    <div class=\"text-info fw-bold mb-1\">${formatCur(req.amount)}</div>\n                    <div class=\"text-white small\">${req.method}</div>\n                    <div class=\"text-muted\" style=\"font-size:0.75rem\">${req.address}</div>\n                    <div class=\"mt-1\">${statusBadge}</div>\n                </td>\n                <td class=\"text-end align-middle px-3\">\n                    ${actionButtons}\n                </td>\n            </tr>`;\n       });\n    }\n\n    // 🚀 NEW: Withdraw Status Update Function\n    window.changeWithdrawStatus = async function(uid, index, newStatus) {\n        if (!confirm(`Are you sure you want to mark this request as ${newStatus}?`)) return;\n        toggleLoading(true);\n        const r = await fetch('/api?action=update_withdraw_status', { \n            method: 'POST', \n            headers: {'Content-Type': 'application/json'}, \n            body: JSON.stringify({admin_id: currentUser.id, target_user: uid, index: index, status: newStatus}) \n        });\n        const d = await r.json();\n        if (d.success) { \n            showToast(`Status updated to ${newStatus}!`); \n            syncBackend({initData: telegramInitData}); \n        } else {\n            showToast(\"Failed to update status\", \"danger\");\n        }\n        toggleLoading(false);\n    }\n\n    window.openEditModal = function(uid, bal) {\n        document.getElementById('editUid').value = uid;\n        document.getElementById('editBalInput').value = bal;\n        document.getElementById('editModalOverlay').style.display = 'flex';\n    }\n    window.closeEditModal = function() { document.getElementById('editModalOverlay').style.display = 'none'; }\n    window.saveEditedBalance = async function() {\n        const uid = document.getElementById('editUid').value;\n        const bal = parseFloat(document.getElementById('editBalInput').value);\n        toggleLoading(true);\n        const r = await fetch('/api?action=edit_balance', { method:'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({admin_id: currentUser.id, target_user: uid, new_balance: bal}) });\n        const d = await r.json();\n        if(d.success) { showToast(\"Balance Updated!\"); closeEditModal(); syncBackend({initData: telegramInitData}); }\n        toggleLoading(false);\n    }\n\n    document.addEventListener(\"DOMContentLoaded\", () => {\n      let tgUser = {};\n      if (window.Telegram && window.Telegram.WebApp) {\n         Telegram.WebApp.expand();\n         const tg = Telegram.WebApp;\n         tgUser = { initData: tg.initData || \"\" };\n      }\n      syncBackend(tgUser);\n\n      document.getElementById(\"show-ad\").addEventListener(\"click\", () => {\n        if (!AdController) return showToast(\"Ads not configured or AdBlock active\", \"danger\");\n        toggleLoading(true);\n        AdController.show().then(async () => {\n           const r = await fetch('/api?action=add_reward', { method:'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: currentUser.id, type: 'ad'}) });\n           const d = await r.json();\n           if(d.success) { currentUser = d.user; updateBasicUI(); updateTaskUI(); showToast(`Earned ${formatCur(appSettings.adRewardAmount)}!`, \"success\"); }\n           toggleLoading(false);\n        }).catch(() => { toggleLoading(false); showToast(\"Ad closed early or failed\", \"warning\"); });\n      });\n\n      document.getElementById(\"claim-daily-bonus\").addEventListener(\"click\", () => {\n        if(dailyBonusClaimed) return showToast(\"You already claimed today!\", \"warning\");\n        if (!AdController) return showToast(\"Ad system not ready\", \"danger\");\n        toggleLoading(true);\n        AdController.show().then(async () => {\n           const r = await fetch('/api?action=add_reward', { method:'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: currentUser.id, type: 'bonus'}) });\n           const d = await r.json();\n           if(d.success) { currentUser = d.user; dailyBonusClaimed = true; updateBasicUI(); showToast(\"Bonus Claimed!\"); }\n           else showToast(d.message, \"warning\");\n           toggleLoading(false);\n        }).catch(() => { toggleLoading(false); showToast(\"Watch full ad to get bonus\", \"warning\"); });\n      });\n\n      document.getElementById(\"submitWithdrawBtn\").addEventListener(\"click\", async () => {\n        const amt = parseFloat(document.getElementById(\"withdraw-amount\").value);\n        const sel = document.getElementById(\"payment-method\");\n        const method = sel.value;\n        const addr = document.getElementById(\"withdraw-address\").value;\n        \n        if (!amt || !method || !addr) return showToast(\"Please fill all required fields\", \"warning\");\n        \n        const minLimit = parseFloat(sel.options[sel.selectedIndex].getAttribute(\"data-min\"));\n        if (amt < minLimit) return showToast(`Minimum limit for ${method} is ${formatCur(minLimit)}`, \"danger\");\n        if (amt > currentUser.balance) return showToast(\"Insufficient balance!\", \"danger\");\n\n        toggleLoading(true);\n        const r = await fetch('/api?action=withdraw', { method:'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: currentUser.id, amount: amt, method: method, address: addr}) });\n        const d = await r.json();\n        \n        if(d.success) {\n            currentUser = d.user; \n            updateBasicUI(); \n            renderHistory();\n            document.getElementById(\"withdraw-form\").reset();\n            updateMinLimit();\n            showToast(\"Withdraw Request Sent!\");\n            syncBackend({initData: telegramInitData}); // Auto Refresh\n        } else { \n            showToast(d.message, \"danger\"); \n        }\n        toggleLoading(false);\n      });\n\n      document.getElementById(\"saveAdminSettingsBtn\").addEventListener(\"click\", async () => {\n         const newSet = {\n             currency: document.getElementById(\"admin-currency\").value.trim() || 'BDT',\n             dailyBonusAmount: parseFloat(document.getElementById(\"admin-daily-bonus\").value),\n             adRewardAmount: parseFloat(document.getElementById(\"admin-ad-reward\").value),\n             adsgramBlockId: document.getElementById(\"admin-block-id\").value,\n             withdrawMethods: document.getElementById(\"admin-withdraw-methods\").value,\n             dailyAdLimit: parseInt(document.getElementById(\"admin-ad-limit\").value),\n             botToken: document.getElementById(\"admin-bot-token\").value.trim()\n         };\n         toggleLoading(true);\n         const r = await fetch('/api?action=update_settings', { method:'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({admin_id: currentUser.id, settings: newSet}) });\n         const d = await r.json();\n         if(d.success) { \n             appSettings = newSet; \n             populateWithdrawMethods(); \n             updateBasicUI(); updateTaskUI();\n             renderAdminPanel();\n             \n             if(window.Adsgram && appSettings.adsgramBlockId) {\n                 AdController = window.Adsgram.init({ blockId: appSettings.adsgramBlockId.toString().trim() });\n             }\n             showToast(\"All configurations saved successfully!\"); \n         }\n         toggleLoading(false);\n      });\n    });\n\n    window.showSection = function(id) {\n      document.querySelectorAll(\"main > section\").forEach(s => s.classList.add(\"d-none\"));\n      document.getElementById(id).classList.remove(\"d-none\");\n      document.querySelectorAll('.app-bottom-nav .nav-item').forEach(n => n.classList.remove('active'));\n      const activeNav = Array.from(document.querySelectorAll('.app-bottom-nav .nav-item')).find(nav => nav.getAttribute('data-section') === id);\n      if (activeNav) activeNav.classList.add('active');\n    }\n  </script>\n</body>\n</html>";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    if (request.method === "GET") {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return json({ success: false, message: "Not found" }, 404);
  }
};
