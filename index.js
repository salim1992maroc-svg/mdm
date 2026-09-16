
const DEFAULT_SETTINGS = {
  currency: "BDT",
  dailyBonusAmount: 0.10,
  adRewardAmount: 0.10,
  dailyAdLimit: 10,
  withdrawMethods: "bKash:200, Nagad:200, Rocket:200, Binance:5",
  adsgramBlockId: "28773",
  appName: "Zelvuno",
  payoutProofEnabled: true
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
function nowDate() { return new Date().toISOString().slice(0, 10); }

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
  const row = await db.prepare("SELECT value FROM settings WHERE key='app'").first();
  if (!row) return { ...DEFAULT_SETTINGS };
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
async function saveSettings(db, settings) {
  await db.prepare(
    "INSERT INTO settings(key,value) VALUES('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(JSON.stringify(settings)).run();
}
async function getWithdrawals(db, userId) {
  const { results } = await db.prepare(
    "SELECT id, created_at AS date, amount, method, address, status FROM withdrawals WHERE user_id=? ORDER BY id DESC"
  ).bind(String(userId)).all();
  return results || [];
}

async function validateTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => k + "=" + v).join("\n");
  const encoder = new TextEncoder();
  const secretKey = await crypto.subtle.importKey(
    "raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const secret = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(botToken));
  const checkKey = await crypto.subtle.importKey(
    "raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", checkKey, encoder.encode(dataCheckString));
  const expected = [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== receivedHash.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ receivedHash.charCodeAt(i);
  if (diff !== 0) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;
  try {
    const user = JSON.parse(params.get("user") || "null");
    return user && user.id ? user : null;
  } catch { return null; }
}

async function requireUser(env, input) {
  const user = await validateTelegramInitData(input?.initData, env.BOT_TOKEN);
  if (!user) throw new Error("Invalid or expired Telegram session");
  const id = String(user.id);
  let row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
  if (!row) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO users
      (id, firstName, lastName, username, photoUrl, balance, adsWatched,
       daily_ad_date, daily_ads_count, lifetimeEarned, lastBonusDate)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      id, user.first_name || "Unknown", user.last_name || "", user.username || "",
      user.photo_url || "", 0, 0, "", 0, 0, ""
    ).run();
  }
  await env.DB.prepare(
    "UPDATE users SET firstName=?,lastName=?,username=?,photoUrl=? WHERE id=?"
  ).bind(user.first_name || "", user.last_name || "", user.username || "",
         user.photo_url || "", id).run();
  row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
  return { user, row, isAdmin: id === String(env.ADMIN_CHAT_ID || "") };
}

async function userPayload(db, row, settings) {
  const user = safeUser(row);
  user.withdrawHistory = await getWithdrawals(db, user.id);
  return { user, bonusClaimed: user.lastBonusDate === nowDate(), settings };
}

async function sendTelegram(env, text, chatId = env.ADMIN_CHAT_ID) {
  if (!env.BOT_TOKEN || !chatId) return { ok: false, skipped: true };
  try {
    const r = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
    });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok && d.ok !== false, data: d };
  } catch { return { ok: false }; }
}

async function adminData(db) {
  const usersQ = await db.prepare("SELECT * FROM users ORDER BY rowid DESC LIMIT 500").all();
  const withdrawalQ = await db.prepare(`
    SELECT w.id,w.user_id,w.amount,w.method,w.address,w.status,w.created_at,
           u.firstName,u.lastName,u.username
    FROM withdrawals w LEFT JOIN users u ON u.id=w.user_id
    ORDER BY w.id DESC LIMIT 500
  `).all();
  const totals = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COALESCE(SUM(balance),0) FROM users) AS balances,
      (SELECT COALESCE(SUM(lifetimeEarned),0) FROM users) AS earned,
      (SELECT COUNT(*) FROM withdrawals WHERE status='Pending') AS pending,
      (SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE status='Completed') AS paid,
      (SELECT COUNT(*) FROM withdrawals WHERE status='Completed') AS paidCount,
      (SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE status='Cancelled') AS cancelled
  `).first();
  const users = {};
  for (const r of usersQ.results || []) users[String(r.id)] = safeUser(r);
  for (const r of Object.values(users)) r.withdrawHistory = [];
  return { users, withdrawals: withdrawalQ.results || [], stats: totals || {} };
}

async function handleApi(request, env) {
  if (!env.DB) return json({ success: false, message: "D1 database binding DB is missing" }, 500);
  const action = new URL(request.url).searchParams.get("action") || "";
  let input = {};
  try { input = await request.json(); } catch {}
  try {
    if (action === "sync_user") {
      const auth = await requireUser(env, input);
      const settings = await getSettings(env.DB);
      const payload = await userPayload(env.DB, auth.row, settings);
      return json({ success: true, ...payload, isAdmin: auth.isAdmin });
    }

    if (action === "public_payouts") {
      const settings = await getSettings(env.DB);
      if (!settings.payoutProofEnabled) {
        return json({ success: true, payouts: [], enabled: false, currency: settings.currency });
      }
      const q = await env.DB.prepare(`
        SELECT
          w.id,
          w.amount,
          w.method,
          w.created_at,
          u.firstName
        FROM withdrawals AS w
        LEFT JOIN users AS u ON u.id = w.user_id
        WHERE w.status = 'Completed'
        ORDER BY w.id DESC
        LIMIT 30
      `).all();
      const payouts = (q.results || []).map(x => ({
        id: Number(x.id || 0),
        amount: Number(x.amount || 0),
        method: String(x.method || ""),
        date: String(x.created_at || ""),
        name: ((String(x.firstName || "User").trim().slice(0, 1) || "U") + "***")
      }));
      return json({ success: true, payouts, enabled: true, currency: settings.currency });
    }

    if (action === "start_ad") {
      const auth = await requireUser(env, input);
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS ad_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `).run();
      const sessionId = crypto.randomUUID();
      const createdAt = Date.now();
      // Keep only the newest pending session for this user.
      await env.DB.prepare("DELETE FROM ad_sessions WHERE user_id=?").bind(String(auth.user.id)).run();
      await env.DB.prepare(
        "INSERT INTO ad_sessions(id,user_id,created_at) VALUES(?,?,?)"
      ).bind(sessionId, String(auth.user.id), createdAt).run();
      return json({ success: true, adSession: sessionId });
    }

    if (action === "add_reward") {
      const auth = await requireUser(env, input);
      const settings = await getSettings(env.DB);
      const type = String(input.type || "");
      if (type === "bonus") {
        const today = nowDate();
        const amount = Number(settings.dailyBonusAmount);
        if (!Number.isFinite(amount) || amount < 0) return json({ success:false, message:"Invalid bonus setting" },400);
        const result = await env.DB.prepare(
          "UPDATE users SET balance=balance+?,lifetimeEarned=lifetimeEarned+?,lastBonusDate=? WHERE id=? AND lastBonusDate<>?"
        ).bind(amount, amount, today, String(auth.user.id), today).run();
        if (!result.meta.changes) return json({ success: false, message: "Already claimed" }, 400);
      } else if (type === "ad") {
        const adSession = String(input.adSession || "").trim();
        if (!adSession || adSession.length > 100) {
          return json({ success:false, message:"Ad session is required" },400);
        }
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS ad_sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at INTEGER NOT NULL
          )
        `).run();
        // A reward can be redeemed only once for a server-issued session.
        // Sessions expire after 10 minutes.
        const cutoff = Date.now() - 10 * 60 * 1000;
        const consumed = await env.DB.prepare(
          "DELETE FROM ad_sessions WHERE id=? AND user_id=? AND created_at>=?"
        ).bind(adSession, String(auth.user.id), cutoff).run();
        if (!consumed.meta.changes) {
          return json({ success:false, message:"Invalid or expired ad session" },400);
        }
        const today = nowDate();
        const amount = Number(settings.adRewardAmount);
        const limit = Math.max(0, Math.floor(Number(settings.dailyAdLimit || 10)));
        if (!Number.isFinite(amount) || amount < 0) return json({success:false,message:"Invalid ad reward setting"},400);
        if (limit < 1) return json({success:false,message:"Ads are temporarily unavailable"},400);
        const result = await env.DB.prepare(`
          UPDATE users SET balance=balance+?, lifetimeEarned=lifetimeEarned+?, adsWatched=adsWatched+1,
            daily_ad_date=?, daily_ads_count=CASE WHEN daily_ad_date=? THEN daily_ads_count+1 ELSE 1 END
          WHERE id=? AND (daily_ad_date<>? OR daily_ad_date IS NULL OR daily_ads_count<?)
        `).bind(amount, amount, today, today, String(auth.user.id), today, limit).run();
        if (!result.meta.changes) return json({ success: false, message: "Daily ad limit reached" }, 400);
      } else return json({ success:false,message:"Invalid reward type" },400);
      const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(String(auth.user.id)).first();
      return json({ success:true,...(await userPayload(env.DB,row,settings)) });
    }

    if (action === "withdraw") {
      const auth = await requireUser(env, input);
      const settings = await getSettings(env.DB);
      const amount = Number(input.amount);
      const method = String(input.method || "").trim();
      const address = String(input.address || "").trim();
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000 || !method || !address || address.length > 200) {
        return json({success:false,message:"Invalid withdrawal"},400);
      }
      const methods = String(settings.withdrawMethods || "").split(",").map(x => {
        const [name,min] = x.split(":");
        return {name:String(name||"").trim(),min:Number(min||0)};
      }).filter(x => x.name);
      const selected = methods.find(x => x.name === method);
      if (!selected) return json({success:false,message:"Invalid payment method"},400);
      if (!Number.isFinite(selected.min) || amount < selected.min) {
        return json({success:false,message:"Minimum withdrawal is "+selected.min},400);
      }
      const updated = await env.DB.prepare(
        "UPDATE users SET balance=balance-? WHERE id=? AND balance>=?"
      ).bind(amount,String(auth.user.id),amount).run();
      if (!updated.meta.changes) return json({success:false,message:"Insufficient balance"},400);
      try {
        await env.DB.prepare(
          "INSERT INTO withdrawals(user_id,amount,method,address,status,created_at) VALUES(?,?,?,?,?,?)"
        ).bind(String(auth.user.id),amount,method,address,"Pending",new Date().toISOString()).run();
      } catch (e) {
        await env.DB.prepare("UPDATE users SET balance=balance+? WHERE id=?").bind(amount,String(auth.user.id)).run();
        throw e;
      }
      const name = ((auth.user.first_name || "")+" "+(auth.user.last_name || "")).trim() || "User";
      await sendTelegram(env,
        "New Withdraw Request\nName: "+name+"\nID: "+auth.user.id+"\nAmount: "+amount+" "+settings.currency+
        "\nMethod: "+method+"\nAddress: "+address
      );
      const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(String(auth.user.id)).first();
      return json({success:true,...(await userPayload(env.DB,row,settings))});
    }

    if (action === "admin_data") {
      const auth = await requireUser(env,input);
      if (!auth.isAdmin) return json({success:false,message:"Unauthorized"},403);
      return json({success:true,...(await adminData(env.DB))});
    }

    if (action === "update_withdraw_status") {
      const auth = await requireUser(env,input);
      if (!auth.isAdmin) return json({success:false,message:"Unauthorized"},403);
      const targetUser=String(input.target_user||"");
      const withdrawalId=Number(input.id||input.index);
      const newStatus=String(input.status||"");
      if(!targetUser||!withdrawalId||!["Completed","Cancelled"].includes(newStatus))
        return json({success:false,message:"Invalid request"},400);
      const w=await env.DB.prepare("SELECT * FROM withdrawals WHERE id=? AND user_id=?").bind(withdrawalId,targetUser).first();
      if(!w) return json({success:false,message:"Withdrawal not found"},404);
      const changed=await env.DB.prepare(
        "UPDATE withdrawals SET status=? WHERE id=? AND user_id=? AND status='Pending'"
      ).bind(newStatus,withdrawalId,targetUser).run();
      if(!changed.meta.changes) return json({success:false,message:"Already processed"},400);
      if(newStatus==="Cancelled"){
        await env.DB.prepare("UPDATE users SET balance=balance+? WHERE id=?").bind(Number(w.amount),targetUser).run();
      }
      return json({success:true});
    }

    if (action === "edit_balance") {
      const auth=await requireUser(env,input);
      if(!auth.isAdmin)return json({success:false,message:"Unauthorized"},403);
      const targetUser=String(input.target_user||"");
      const newBalance=Number(input.new_balance);
      if(!targetUser||!Number.isFinite(newBalance)||newBalance<0||newBalance>100000000)
        return json({success:false,message:"Invalid balance"},400);
      const r=await env.DB.prepare("UPDATE users SET balance=? WHERE id=?").bind(newBalance,targetUser).run();
      if(!r.meta.changes)return json({success:false,message:"User not found"},404);
      return json({success:true});
    }

    if (action === "update_settings") {
      const auth=await requireUser(env,input);
      if(!auth.isAdmin)return json({success:false,message:"Unauthorized"},403);
      const incoming=input.settings||{};
      const adReward=Number(incoming.adRewardAmount);
      const bonus=Number(incoming.dailyBonusAmount);
      const limit=Math.floor(Number(incoming.dailyAdLimit));
      if(!Number.isFinite(adReward)||adReward<0||!Number.isFinite(bonus)||bonus<0||!Number.isFinite(limit)||limit<0||limit>1000)
        return json({success:false,message:"Invalid settings"},400);
      const settings={
        ...DEFAULT_SETTINGS,
        currency:String(incoming.currency??DEFAULT_SETTINGS.currency).trim().slice(0,10)||"BDT",
        dailyBonusAmount:bonus,
        adRewardAmount:adReward,
        dailyAdLimit:limit,
        withdrawMethods:String(incoming.withdrawMethods??DEFAULT_SETTINGS.withdrawMethods).slice(0,1000),
        adsgramBlockId:String(incoming.adsgramBlockId??DEFAULT_SETTINGS.adsgramBlockId).trim().slice(0,100),
        appName:String(incoming.appName??DEFAULT_SETTINGS.appName).trim().slice(0,40)||"Zelvuno",
        payoutProofEnabled:Boolean(incoming.payoutProofEnabled)
      };
      await saveSettings(env.DB,settings);
      return json({success:true,settings});
    }

    if (action === "broadcast") {
      const auth=await requireUser(env,input);
      if(!auth.isAdmin)return json({success:false,message:"Unauthorized"},403);
      const text=String(input.text||"").trim();
      if(!text||text.length>3500)return json({success:false,message:"Message must be 1-3500 characters"},400);
      const q=await env.DB.prepare("SELECT id FROM users ORDER BY rowid ASC LIMIT 5000").all();
      let sent=0,failed=0;
      for(const r of (q.results||[])){
        const result=await sendTelegram(env,text,String(r.id));
        if(result.ok)sent++;else failed++;
        await new Promise(resolve=>setTimeout(resolve,35));
      }
      return json({success:true,sent,failed});
    }

    if (action === "adsgram_reward") {
      // Optional AdsGram Reward URL endpoint.
      // AdsGram documents this as an additional server-side confirmation for publishers
      // and sends ?userid=[userId]. It should not be treated as the only anti-fraud control.
      const userid=String(new URL(request.url).searchParams.get("userid")||"").trim();
      if(!/^\d+$/.test(userid))return json({success:false,message:"Invalid userid"},400);
      return json({success:true,received:true});
    }

    return json({success:false,message:"Unknown action"},404);
  } catch(e) {
    return json({success:false,message:e?.message||"Server error"},500);
  }
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=0">
<title>Zelvuno</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src="https://sad.adsgram.ai/js/sad.min.js"></script>
<style>
*{box-sizing:border-box}body{margin:0;background:#050b14;color:#fff;font-family:Arial,sans-serif}.container{width:94%;max-width:720px;margin:auto;padding-top:12px}.card{background:#10192b;border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:18px;margin:14px 0}.hero{padding:22px}.balance{font-size:30px;font-weight:800;color:#19c9f5}.muted{color:#9aa6b2;font-size:13px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.stat{background:#0a1220;border-radius:14px;padding:13px}.stat b{font-size:19px;display:block;margin-top:5px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.space{justify-content:space-between}.primary,.success,.danger,.ghost{border:0;border-radius:12px;padding:12px 16px;font-weight:700;cursor:pointer}.primary{background:linear-gradient(135deg,#08c8dc,#356bdc);color:#fff}.success{background:#36c98f;color:#001018}.danger{background:#e45b68;color:#fff}.ghost{background:#18253a;color:#dbe7f3}.small{padding:8px 10px;font-size:12px}button:disabled{opacity:.5}input,select,textarea{width:100%;padding:13px;margin:6px 0;background:#050b14;color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:12px;font:inherit}textarea{min-height:110px;resize:vertical}.table{overflow:auto}.item{border-bottom:1px solid rgba(255,255,255,.08);padding:12px 0}.item:last-child{border-bottom:0}.tag{display:inline-block;padding:4px 8px;border-radius:20px;background:#17253b;color:#9edfff;font-size:11px}.hidden{display:none!important}nav{position:fixed;bottom:0;left:0;right:0;height:70px;background:#10192b;border-top:1px solid rgba(255,255,255,.08);display:flex;justify-content:space-around;align-items:center;z-index:20}nav button{background:none;border:0;color:#9aa6b2;font-weight:700}nav button.active{color:#16c8ef}.toast{position:fixed;top:18px;left:50%;transform:translateX(-50%);background:#17243a;padding:12px 18px;border-radius:12px;z-index:10000;display:none;max-width:90%;text-align:center}.spinner{width:44px;height:44px;border:4px solid rgba(255,255,255,.15);border-top-color:#00d2ff;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}#loading{position:fixed;inset:0;background:#050b14;display:flex;align-items:center;justify-content:center;z-index:9999}.proof{font-size:13px}
section{padding-bottom:90px}
</style>
</head>
<body>
<div id="loading"><div class="spinner"></div></div><div id="toast" class="toast"></div>
<div class="container">
<section id="home">
  <div class="card hero"><div class="muted">Hello,</div><h2 id="headerName">Loading...</h2><div class="balance"><span id="homeBalance">0.00</span> <span id="homeCurrency">BDT</span></div><div class="muted">Available balance</div></div>
  <div class="card"><h3>Daily Bonus</h3><p id="bonusText" class="muted"></p><button id="bonusBtn" class="primary">Claim Daily Bonus</button></div>
  <div class="card"><h3>Earn with Ads</h3><p>Watch an optional rewarded ad to receive the displayed bonus. You never need to click the advertisement.</p><div class="row space"><span class="tag">Rewarded Ad</span><span class="muted">Today: <b id="adsToday">0</b></span></div><br><button id="adBtn" class="primary">📺 Watch Ad for Bonus</button></div>
  <div class="card"><h3>Recent Payout Proof</h3><p class="muted">Completed withdrawals are shown here as payout confirmations.</p><div id="proofList" class="proof">Loading...</div></div>
</section>

<section id="withdraw" class="hidden">
  <div class="card"><h2>Withdraw Funds</h2><p>Current: <b id="withdrawBalance">0.00</b> <span id="withdrawCurrency">BDT</span></p>
    <label>Payment method</label><select id="paymentMethod"><option value="">Choose Method</option></select>
    <label>Amount</label><input id="withdrawAmount" type="number" step="0.01" min="0.01" placeholder="Enter amount">
    <label>Account Number / Address</label><input id="withdrawAddress" maxlength="200" placeholder="Enter details...">
    <button id="withdrawBtn" class="primary">Submit Request</button>
  </div>
  <div class="card"><h3>Withdrawal History</h3><div id="history"></div></div>
</section>

<section id="admin" class="hidden">
  <div class="card"><div class="row space"><div><h2>🔐 Admin Dashboard</h2><span class="tag">Private</span></div><button id="refreshAdmin" class="ghost small">Refresh</button></div></div>
  <div class="grid">
    <div class="stat"><span class="muted">Users</span><b id="sUsers">0</b></div>
    <div class="stat"><span class="muted">Total balances</span><b id="sBalances">0</b></div>
    <div class="stat"><span class="muted">Lifetime earned</span><b id="sEarned">0</b></div>
    <div class="stat"><span class="muted">Pending withdrawals</span><b id="sPending">0</b></div>
    <div class="stat"><span class="muted">Paid withdrawals</span><b id="sPaid">0</b></div>
    <div class="stat"><span class="muted">Paid amount</span><b id="sPaidAmount">0</b></div>
  </div>
  <div class="card"><h3>⚙️ App & Ads Settings</h3>
    <label>App name</label><input id="setName">
    <label>Currency</label><input id="setCurrency">
    <label>Daily bonus</label><input id="setBonus" type="number" step="0.01">
    <label>Reward per completed ad</label><input id="setAdReward" type="number" step="0.01">
    <label>Daily ad limit</label><input id="setAdLimit" type="number" min="1" max="1000">
    <label>Withdrawal methods (Name:Minimum, comma separated)</label><input id="setMethods">
    <label>AdsGram Block ID</label><input id="setBlock">
    <label><input id="setProof" type="checkbox" style="width:auto"> Show payout proof section</label><br><button id="saveSettings" class="primary">Save Settings</button>
  </div>
  <div class="card"><h3>👥 Users</h3><input id="userSearch" placeholder="Search name, username or Telegram ID"><div id="usersList"></div></div>
  <div class="card"><h3>💸 Withdrawal Requests</h3><div id="withdrawalsList"></div></div>
  <div class="card"><h3>📢 Broadcast</h3><p class="muted">Send a message to registered users. Use only for legitimate app updates and notices.</p><textarea id="broadcastText" maxlength="3500" placeholder="Message..."></textarea><button id="broadcastBtn" class="primary">Send to Users</button><div id="broadcastResult" class="muted"></div></div>
</section>
</div>
<nav><button data-section="home" class="active">🏠 Home</button><button data-section="withdraw">💳 Withdraw</button><button id="adminNav" data-section="admin" class="hidden">🔐 Admin</button></nav>

<script>
const tg=window.Telegram?.WebApp;let initData="",state=null,isAdmin=false,adminCache=null;
const $=id=>document.getElementById(id);
function toast(m){const e=$("toast");e.textContent=m;e.style.display="block";clearTimeout(window.__t);window.__t=setTimeout(()=>e.style.display="none",2600)}
function money(v){return Number(v||0).toFixed(2)}
function esc(s){return String(s??"").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\\"":"&quot;"}[c]||c))}
async function api(action,body={}){const r=await fetch("/api?action="+encodeURIComponent(action),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...body,initData})});let d={};try{d=await r.json()}catch{}if(!r.ok||d.success===false)throw new Error(d.message||"Request failed");return d}
function apply(data){state=data;isAdmin=!!data.isAdmin;const u=data.user,s=data.settings;$("headerName").textContent=u.firstName+(u.lastName?" "+u.lastName:"");$("homeBalance").textContent=money(u.balance);$("withdrawBalance").textContent=money(u.balance);$("homeCurrency").textContent=s.currency;$("withdrawCurrency").textContent=s.currency;$("adsToday").textContent=u.dailyAdDate===new Date().toISOString().slice(0,10)?u.dailyAdsCount:0;$("bonusText").textContent=data.bonusClaimed?"Already claimed today":"Today: "+money(s.dailyBonusAmount)+" "+s.currency;$("bonusBtn").disabled=data.bonusClaimed;fillMethods(s.withdrawMethods);renderHistory(u.withdrawHistory);if(isAdmin)$("adminNav").classList.remove("hidden")}
function fillMethods(text){const e=$("paymentMethod"),old=e.value;e.innerHTML='<option value="">Choose Method</option>';String(text||"").split(",").forEach(x=>{const [n,m]=x.split(":");if(!n)return;const o=document.createElement("option");o.value=n.trim();o.textContent=n.trim()+" (min "+Number(m||0)+")";e.appendChild(o)});if(old)e.value=old}
function renderHistory(items){const e=$("history");if(!items?.length){e.innerHTML='<p class="muted">No withdrawals yet.</p>';return}e.innerHTML=items.map(w=>'<div class="item"><b>'+money(w.amount)+"</b> "+esc(w.method)+' <span class="tag">'+esc(w.status)+'</span><br><span class="muted">'+esc(w.date||"")+' · '+esc(w.address)+'</span></div>').join("")}
async function refresh(){apply(await api("sync_user"));await loadProof();if(isAdmin)await refreshAdmin()}
async function loadProof(){try{const d=await api("public_payouts",{});if(!d.enabled){$("proofList").innerHTML='<p class="muted">Payout proof is currently disabled.</p>';return}if(!d.payouts.length){$("proofList").innerHTML='<p class="muted">No completed payouts yet.</p>';return}$("proofList").innerHTML=d.payouts.map(p=>'<div class="item">✓ <b>'+esc(p.name)+'</b> received <b>'+money(p.amount)+" "+esc(d.currency)+"</b> via "+esc(p.method)+'<br><span class="muted">'+esc(p.date)+'</span></div>').join("")}catch(e){$("proofList").textContent="Unable to load payout proof"}}
async function watchAd(){const b=$("adBtn");b.disabled=true;try{if(!window.Adsgram)throw new Error("Ads service is unavailable");const id=String(state.settings.adsgramBlockId||"").trim();if(!id)throw new Error("AdsGram Block ID is not configured");const session=await api("start_ad",{});const c=window.Adsgram.init({blockId:id});const result=await c.show();if(!result||result.done!==true)throw new Error("Ad was not completed");const d=await api("add_reward",{type:"ad",adSession:session.adSession});apply(d);toast("Reward added")}catch(e){toast(e.message)}finally{b.disabled=false}}
$("bonusBtn").onclick=async()=>{try{apply(await api("add_reward",{type:"bonus"}));toast("Daily bonus added")}catch(e){toast(e.message)}};
$("adBtn").onclick=watchAd;
$("withdrawBtn").onclick=async()=>{try{const amount=Number($("withdrawAmount").value),method=$("paymentMethod").value,address=$("withdrawAddress").value.trim();apply(await api("withdraw",{amount,method,address}));$("withdrawAmount").value="";$("withdrawAddress").value="";toast("Withdrawal submitted")}catch(e){toast(e.message)}};

function fillSettings(s){$("setName").value=s.appName||"Zelvuno";$("setCurrency").value=s.currency;$("setBonus").value=s.dailyBonusAmount;$("setAdReward").value=s.adRewardAmount;$("setAdLimit").value=s.dailyAdLimit;$("setMethods").value=s.withdrawMethods;$("setBlock").value=s.adsgramBlockId;$("setProof").checked=!!s.payoutProofEnabled}
function renderStats(s){$("sUsers").textContent=s.users||0;$("sBalances").textContent=money(s.balances);$("sEarned").textContent=money(s.earned);$("sPending").textContent=s.pending||0;$("sPaid").textContent=s.paidCount||0;$("sPaidAmount").textContent=money(s.paid)}
function renderUsers(){const q=$("userSearch").value.trim().toLowerCase(),users=adminCache?.users||{};const arr=Object.values(users).filter(u=>(u.id+" "+u.firstName+" "+u.lastName+" "+u.username).toLowerCase().includes(q));$("usersList").innerHTML=arr.length?arr.map(u=>'<div class="item"><b>'+esc((u.firstName+" "+u.lastName).trim())+'</b><br><span class="muted">@'+esc(u.username||"no_username")+' · ID '+esc(u.id)+'</span><br>Balance: <b>'+money(u.balance)+'</b> · Ads: '+u.adsWatched+'<br><button class="ghost small" onclick="editBal(\\''+esc(u.id)+'\\')">Edit Balance</button></div>').join(""):'<p class="muted">No matching users.</p>'}
function renderWithdrawals(){const arr=adminCache?.withdrawals||[];$("withdrawalsList").innerHTML=arr.length?arr.map(w=>'<div class="item"><b>'+money(w.amount)+'</b> '+esc(w.method)+' <span class="tag">'+esc(w.status)+'</span><br><span class="muted">'+esc((w.firstName||"")+" "+(w.lastName||""))+' · ID '+esc(w.user_id)+' · '+esc(w.created_at||"")+'</span><br>Account: '+esc(w.address)+(w.status==="Pending"?'<br><button class="success small" onclick="processW('+Number(w.id)+',\\''+esc(w.user_id)+'\\',\\'Completed\\')">Mark Paid</button> <button class="danger small" onclick="processW('+Number(w.id)+',\\''+esc(w.user_id)+'\\',\\'Cancelled\\')">Cancel + Refund</button>':'')+'</div>').join(""):'<p class="muted">No withdrawals.</p>'}
async function refreshAdmin(){if(!isAdmin)return;try{adminCache=await api("admin_data");renderStats(adminCache.stats);renderUsers();renderWithdrawals();fillSettings(state.settings)}catch(e){toast(e.message)}}
async function processW(id,user,status){if(!confirm(status==="Completed"?"Mark this withdrawal as paid?":"Cancel and refund this withdrawal?"))return;try{await api("update_withdraw_status",{id,target_user:user,status});await refreshAdmin();toast(status==="Completed"?"Marked as paid":"Cancelled and refunded")}catch(e){toast(e.message)}}
async function editBal(id){const v=prompt("New balance");if(v===null)return;try{await api("edit_balance",{target_user:id,new_balance:Number(v)});await refreshAdmin();toast("Balance updated")}catch(e){toast(e.message)}}
$("userSearch").oninput=renderUsers;$("refreshAdmin").onclick=refreshAdmin;
$("saveSettings").onclick=async()=>{try{const settings={appName:$("setName").value,currency:$("setCurrency").value,dailyBonusAmount:Number($("setBonus").value),adRewardAmount:Number($("setAdReward").value),dailyAdLimit:Number($("setAdLimit").value),withdrawMethods:$("setMethods").value,adsgramBlockId:$("setBlock").value,payoutProofEnabled:$("setProof").checked};const d=await api("update_settings",{settings});state.settings=d.settings;apply(state);fillSettings(d.settings);toast("Settings saved")}catch(e){toast(e.message)}};
$("broadcastBtn").onclick=async()=>{const text=$("broadcastText").value.trim();if(!text)return toast("Write a message first");if(!confirm("Send this message to registered users?"))return;const b=$("broadcastBtn");b.disabled=true;try{const d=await api("broadcast",{text});$("broadcastResult").textContent="Sent: "+d.sent+" · Failed: "+d.failed;$("broadcastText").value="";toast("Broadcast finished")}catch(e){toast(e.message)}finally{b.disabled=false}};
document.querySelectorAll("nav button[data-section]").forEach(b=>b.onclick=()=>{if(b.classList.contains("hidden"))return;document.querySelectorAll("section").forEach(s=>s.classList.add("hidden"));$(b.dataset.section).classList.remove("hidden");document.querySelectorAll("nav button").forEach(x=>x.classList.remove("active"));b.classList.add("active");if(b.dataset.section==="admin")refreshAdmin()});
(async()=>{try{if(!tg)throw new Error("Open this app from Telegram");tg.ready();tg.expand();initData=tg.initData||"";if(!initData)throw new Error("Telegram session is unavailable");await refresh()}catch(e){$("headerName").textContent=e.message;toast(e.message)}finally{$("loading").style.display="none"}})();
</script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api") return handleApi(request, env);
    if (url.pathname === "/adsgram/reward") {
      const userid = url.searchParams.get("userid") || "";
      return json({success:/^\d+$/.test(userid),received:/^\d+$/.test(userid)});
    }
    return new Response(HTML, {
      headers: {"content-type":"text/html; charset=utf-8","cache-control":"no-store"}
    });
  }
};
