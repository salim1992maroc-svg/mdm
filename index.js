/**
 * Zelvuno Telegram Mini App - Cloudflare Worker + D1
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
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
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
  const row = await db.prepare("SELECT value FROM settings WHERE key='app'").first();
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
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
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const encoder = new TextEncoder();
  const secretKey = await crypto.subtle.importKey(
    "raw", encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const secret = await crypto.subtle.sign(
    "HMAC", secretKey, encoder.encode(botToken)
  );
  const checkKey = await crypto.subtle.importKey(
    "raw", secret,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC", checkKey, encoder.encode(dataCheckString)
  );
  const expected = [...new Uint8Array(signature)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected.length !== receivedHash.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ receivedHash.charCodeAt(i);
  }
  if (diff !== 0) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;

  try {
    const user = JSON.parse(params.get("user") || "null");
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

async function requireUser(env, input) {
  const user = await validateTelegramInitData(input?.initData, env.BOT_TOKEN);
  if (!user) throw new Error("Invalid or expired Telegram session");

  const id = String(user.id);
  let row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();

  if (!row) {
    await env.DB.prepare(`
      INSERT INTO users
      (id, firstName, lastName, username, photoUrl, balance, adsWatched,
       daily_ad_date, daily_ads_count, lifetimeEarned, lastBonusDate)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      id, user.first_name || "Unknown", user.last_name || "", user.username || "",
      user.photo_url || "", 0, 0, "", 0, 0, ""
    ).run();
  } else {
    await env.DB.prepare(
      "UPDATE users SET firstName=?,lastName=?,username=?,photoUrl=? WHERE id=?"
    ).bind(
      user.first_name || "", user.last_name || "", user.username || "",
      user.photo_url || "", id
    ).run();
  }

  row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
  return { user, row, isAdmin: id === String(env.ADMIN_CHAT_ID || "") };
}

async function userPayload(db, row, settings) {
  const user = safeUser(row);
  user.withdrawHistory = await getWithdrawals(db, user.id);
  const today = nowDate();
  return { user, bonusClaimed: user.lastBonusDate === today, settings };
}

async function sendTelegram(env, text) {
  if (!env.BOT_TOKEN || !env.ADMIN_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.ADMIN_CHAT_ID, text })
  });
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
      const auth = await requireUser(env, input);
      const settings = await getSettings(env.DB);
      const type = String(input.type || "");

      if (type === "bonus") {
        const today = nowDate();
        const amount = Number(settings.dailyBonusAmount);
        const result = await env.DB.prepare(
          "UPDATE users SET balance=balance+?,lifetimeEarned=lifetimeEarned+?,lastBonusDate=? WHERE id=? AND lastBonusDate<>?"
        ).bind(amount, amount, today, String(auth.user.id), today).run();
        if (!result.meta.changes) return json({ success: false, message: "Already claimed" }, 400);
      } else if (type === "ad") {
        const today = nowDate();
        const amount = Number(settings.adRewardAmount);
        const limit = Math.max(0, Number(settings.dailyAdLimit || 10));
        const result = await env.DB.prepare(`
          UPDATE users SET
            balance=balance+?, lifetimeEarned=lifetimeEarned+?, adsWatched=adsWatched+1,
            daily_ad_date=?,
            daily_ads_count=CASE WHEN daily_ad_date=? THEN daily_ads_count+1 ELSE 1 END
          WHERE id=? AND (daily_ad_date<>? OR daily_ad_date IS NULL OR daily_ads_count<?)
        `).bind(amount, amount, today, today, String(auth.user.id), today, limit).run();
        if (!result.meta.changes) return json({ success: false, message: "Daily ad limit reached" }, 400);
      } else {
        return json({ success: false, message: "Invalid reward type" }, 400);
      }

      const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(String(auth.user.id)).first();
      return json({ success: true, ...(await userPayload(env.DB, row, settings)) });
    }

    if (action === "withdraw") {
      const auth = await requireUser(env, input);
      const settings = await getSettings(env.DB);
      const amount = Number(input.amount);
      const method = String(input.method || "").trim();
      const address = String(input.address || "").trim();
      if (!Number.isFinite(amount) || amount <= 0 || !method || !address) {
        return json({ success: false, message: "Invalid withdrawal" }, 400);
      }

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
        "INSERT INTO withdrawals(user_id,amount,method,address,status,created_at) VALUES(?,?,?,?,?,?)"
      ).bind(String(auth.user.id), amount, method, address, "Pending", new Date().toISOString()).run();

      const name = `${auth.user.first_name || ""} ${auth.user.last_name || ""}`.trim();
      await sendTelegram(env,
        `New Withdraw Request\nName: ${name}\nID: ${auth.user.id}\nAmount: ${amount} ${settings.currency || "BDT"}\nMethod: ${method}\nAddress: ${address}`
      );

      const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(String(auth.user.id)).first();
      return json({ success: true, ...(await userPayload(env.DB, row, settings)) });
    }

    if (action === "update_withdraw_status") {
      const auth = await requireUser(env, input);
      if (!auth.isAdmin) return json({ success: false, message: "Unauthorized" }, 403);
      const targetUser = String(input.target_user || "");
      const withdrawalId = Number(input.index);
      const newStatus = String(input.status || "");
      if (!targetUser || !withdrawalId || !["Completed", "Cancelled"].includes(newStatus)) {
        return json({ success: false, message: "Invalid request" }, 400);
      }
      const withdrawal = await env.DB.prepare(
        "SELECT * FROM withdrawals WHERE id=? AND user_id=?"
      ).bind(withdrawalId, targetUser).first();
      if (!withdrawal) return json({ success: false, message: "Withdrawal not found" }, 404);
      if (withdrawal.status !== "Pending") return json({ success: false, message: "Already processed" }, 400);

      await env.DB.prepare("UPDATE withdrawals SET status=? WHERE id=?").bind(newStatus, withdrawalId).run();
      if (newStatus === "Cancelled") {
        await env.DB.prepare("UPDATE users SET balance=balance+? WHERE id=?").bind(Number(withdrawal.amount), targetUser).run();
      }
      const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(targetUser).first();
      const settings = await getSettings(env.DB);
      return json({ success: true, ...(await userPayload(env.DB, row, settings)) });
    }

    if (action === "edit_balance") {
      const auth = await requireUser(env, input);
      if (!auth.isAdmin) return json({ success: false, message: "Unauthorized" }, 403);
      const targetUser = String(input.target_user || "");
      const newBalance = Number(input.new_balance);
      if (!targetUser || !Number.isFinite(newBalance) || newBalance < 0) {
        return json({ success: false, message: "Invalid balance" }, 400);
      }
      await env.DB.prepare("UPDATE users SET balance=? WHERE id=?").bind(newBalance, targetUser).run();
      return json({ success: true });
    }

    if (action === "update_settings") {
      const auth = await requireUser(env, input);
      if (!auth.isAdmin) return json({ success: false, message: "Unauthorized" }, 403);
      const incoming = input.settings || {};
      const settings = {
        ...DEFAULT_SETTINGS,
        currency: String(incoming.currency ?? DEFAULT_SETTINGS.currency).trim(),
        dailyBonusAmount: Number(incoming.dailyBonusAmount ?? DEFAULT_SETTINGS.dailyBonusAmount),
        adRewardAmount: Number(incoming.adRewardAmount ?? DEFAULT_SETTINGS.adRewardAmount),
        dailyAdLimit: Math.max(0, Number(incoming.dailyAdLimit ?? DEFAULT_SETTINGS.dailyAdLimit)),
        withdrawMethods: String(incoming.withdrawMethods ?? DEFAULT_SETTINGS.withdrawMethods),
        adsgramBlockId: String(incoming.adsgramBlockId ?? DEFAULT_SETTINGS.adsgramBlockId)
      };
      await saveSettings(env.DB, settings);
      return json({ success: true, settings });
    }

    return json({ success: false, message: "Unknown action" }, 404);
  } catch (error) {
    return json({ success: false, message: error?.message || "Server error" }, 500);
  }
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0">
<title>Zelvuno</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src="https://sad.adsgram.ai/js/sad.min.js"></script>
<style>
body{margin:0;background:#050b14;color:#fff;font-family:Arial,sans-serif}.container{width:92%;max-width:600px;margin:auto}.card{background:#10192b;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:20px;margin:15px 0}button{border:0;border-radius:12px;padding:12px 18px;cursor:pointer}.primary{background:#00d2ff;color:#001018;font-weight:bold}button:disabled{opacity:.5;cursor:not-allowed}input,select{width:100%;box-sizing:border-box;padding:13px;margin:7px 0;background:#050b14;color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:10px}nav{position:fixed;bottom:0;left:0;right:0;height:70px;background:#10192b;display:flex;justify-content:space-around;align-items:center}nav button{background:none;color:#aaa}nav button.active{color:#00d2ff}section{padding-bottom:90px}.hidden{display:none!important}.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#17243a;padding:14px 20px;border-radius:12px;z-index:10000;display:none}.admin-user{border-bottom:1px solid rgba(255,255,255,.1);padding:12px 0}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.muted{color:#9aa6b2;font-size:13px}.danger{background:#ff5c5c;color:#fff}.success{background:#36c98f;color:#001018}.small{padding:8px 10px;font-size:12px}
#loading-spinner{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#050b14;z-index:9999}.spinner{width:45px;height:45px;border:4px solid rgba(255,255,255,.15);border-top-color:#00d2ff;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div id="loading-spinner"><div class="spinner"></div></div><div id="toast" class="toast"></div>
<div class="container">
<section id="home">
<div class="card"><small>Welcome</small><h2 id="headerUserName">Loading...</h2><h1><span id="homeBalance">0.00</span></h1><p>Balance: <span id="globalBalance">0.00</span></p></div>
<div class="card"><h3>Daily Bonus</h3><p id="daily-bonus-text">Get your daily reward</p><button id="claim-daily-bonus" class="primary">Claim Bonus</button></div>
<div class="card"><h3>Watch Ads</h3><p>Ads watched today: <span id="ads-watched">0</span></p><p>Reward: <span id="ad-reward">0.10</span></p><button id="show-ad" class="primary">Watch Ad</button></div>
</section>
<section id="withdraw" class="hidden"><div class="card"><h3>Withdraw</h3><form id="withdraw-form"><input type="number" id="withdraw-amount" placeholder="Amount" step="0.01" min="0.01"><select id="payment-method"><option value="">Select payment method</option></select><input type="text" id="withdraw-address" placeholder="Payment address"><button type="button" id="submitWithdrawBtn" class="primary">Submit Withdrawal</button></form></div><div class="card"><h3>Withdrawal History</h3><div id="history-list"></div></div></section>
<section id="admin" class="hidden"><div class="card"><h2>Admin Panel</h2><div id="admin-users"></div></div><div class="card"><h3>Settings</h3><label>Currency</label><input id="set-currency"><label>Daily bonus</label><input id="set-bonus" type="number" step="0.01"><label>Ad reward</label><input id="set-ad-reward" type="number" step="0.01"><label>Daily ad limit</label><input id="set-ad-limit" type="number" min="0"><label>Withdraw methods</label><input id="set-withdraw-methods"><label>Adsgram Block ID</label><input id="set-adsgram-block"><button id="save-settings" class="primary">Save Settings</button></div></section>
</div>
<nav><button data-section="home" class="active">Home</button><button data-section="withdraw">Withdraw</button><button id="admin-nav" data-section="admin" class="hidden">Admin</button></nav>
<script>
const tg = window.Telegram?.WebApp;
let IS_ADMIN = false;
let telegramInitData = "";
let state = null;

function toast(message){const el=document.getElementById('toast');el.textContent=message;el.style.display='block';clearTimeout(window.__toast);window.__toast=setTimeout(()=>el.style.display='none',2500)}
function money(v){return Number(v||0).toFixed(2)}
function api(action, body={}){return fetch('/api?action='+encodeURIComponent(action),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,initData:telegramInitData})}).then(async r=>{let d={};try{d=await r.json()}catch{}if(!r.ok||d.success===false)throw new Error(d.message||'Request failed');return d})}
function applyPayload(data){state=data;IS_ADMIN=!!data.isAdmin;const u=data.user,s=data.settings;document.getElementById('headerUserName').textContent=u.firstName+(u.lastName?' '+u.lastName:'');document.getElementById('homeBalance').textContent=money(u.balance);document.getElementById('globalBalance').textContent=money(u.balance);document.getElementById('ads-watched').textContent=u.dailyAdDate===new Date().toISOString().slice(0,10)?u.dailyAdsCount:0;document.getElementById('ad-reward').textContent=money(s.adRewardAmount);document.getElementById('daily-bonus-text').textContent=data.bonusClaimed?'Bonus already claimed today':'Daily bonus: '+money(s.dailyBonusAmount);document.getElementById('claim-daily-bonus').disabled=data.bonusClaimed;populateMethods(s.withdrawMethods);renderHistory(u.withdrawHistory);if(IS_ADMIN){document.getElementById('admin-nav').classList.remove('hidden');renderAdmin(data.all_users||{});fillSettings(s)}}
function populateMethods(text){const sel=document.getElementById('payment-method'),old=sel.value;sel.innerHTML='<option value="">Select payment method</option>';String(text||'').split(',').forEach(x=>{const [name,min]=x.split(':');if(!name)return;const o=document.createElement('option');o.value=name.trim();o.textContent=name.trim()+' (min '+Number(min||0)+')';sel.appendChild(o)});if(old)sel.value=old}
function renderHistory(items){const el=document.getElementById('history-list');if(!items?.length){el.innerHTML='<p class="muted">No withdrawals yet.</p>';return}el.innerHTML=items.map(x=>'<div class="admin-user"><b>'+escapeHtml(x.method)+'</b> — '+money(x.amount)+'<br><span class="muted">'+escapeHtml(x.status)+' · '+escapeHtml(x.date||'')+'</span><br><span class="muted">'+escapeHtml(x.address)+'</span></div>').join('')}
function renderAdmin(users){const el=document.getElementById('admin-users');const ids=Object.keys(users);if(!ids.length){el.innerHTML='<p class="muted">No users.</p>';return}el.innerHTML=ids.map(id=>{const u=users[id];const rows=(u.withdrawHistory||[]).map(w=>'<div class="admin-user"><b>'+money(w.amount)+' '+escapeHtml(w.method)+'</b> — '+escapeHtml(w.status)+'<br><span class="muted">'+escapeHtml(w.address)+'</span><br>'+(w.status==='Pending'?'<button class="small success" onclick="setWithdrawal(\\''+escapeAttr(id)+'\\','+Number(w.id)+',\\'Completed\\')">Complete</button> <button class="small danger" onclick="setWithdrawal(\\''+escapeAttr(id)+'\\','+Number(w.id)+',\\'Cancelled\\')">Cancel</button>':'')+'</div>').join('');return '<div class="admin-user"><b>'+escapeHtml(u.firstName+' '+u.lastName)+'</b><br><span class="muted">@'+escapeHtml(u.username||'no_username')+' · ID '+escapeHtml(id)+'</span><p>Balance: '+money(u.balance)+' <button class="small" onclick="editBalance(\\''+escapeAttr(id)+'\\')">Edit</button></p>'+rows+'</div>'}).join('')}
function escapeHtml(s){return String(s??'').replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]))}
function escapeAttr(s){return String(s??'').replace(/\\/g,'\\\\').replace(/'/g,"\\'")}
async function refresh(){const d=await api('sync_user');applyPayload(d)}
async function setWithdrawal(user,id,status){try{const d=await api('update_withdraw_status',{target_user:user,index:id,status});await refresh();toast(status==='Completed'?'Withdrawal completed':'Withdrawal cancelled')}catch(e){toast(e.message)}}
async function editBalance(user){const value=prompt('New balance');if(value===null)return;try{await api('edit_balance',{target_user:user,new_balance:Number(value)});await refresh();toast('Balance updated')}catch(e){toast(e.message)}}
function fillSettings(s){document.getElementById('set-currency').value=s.currency;document.getElementById('set-bonus').value=s.dailyBonusAmount;document.getElementById('set-ad-reward').value=s.adRewardAmount;document.getElementById('set-ad-limit').value=s.dailyAdLimit;document.getElementById('set-withdraw-methods').value=s.withdrawMethods;document.getElementById('set-adsgram-block').value=s.adsgramBlockId}
async function watchAd(){const btn=document.getElementById('show-ad');btn.disabled=true;try{if(!window.Adsgram)throw new Error('Adsgram is not loaded');const blockId=String(state.settings.adsgramBlockId||'');if(!blockId)throw new Error('Adsgram Block ID is not configured');const controller=window.Adsgram.init({blockId});await controller.show();const d=await api('add_reward',{type:'ad'});applyPayload(d);toast('Ad reward added')}catch(e){toast(e.message)}finally{btn.disabled=false}}

document.getElementById('claim-daily-bonus').onclick=async()=>{try{const d=await api('add_reward',{type:'bonus'});applyPayload(d);toast('Bonus claimed')}catch(e){toast(e.message)}};
document.getElementById('show-ad').onclick=watchAd;
document.getElementById('submitWithdrawBtn').onclick=async()=>{try{const amount=Number(document.getElementById('withdraw-amount').value),method=document.getElementById('payment-method').value,address=document.getElementById('withdraw-address').value.trim();const d=await api('withdraw',{amount,method,address});applyPayload(d);document.getElementById('withdraw-form').reset();toast('Withdrawal submitted')}catch(e){toast(e.message)}};
document.getElementById('save-settings').onclick=async()=>{try{const settings={currency:document.getElementById('set-currency').value,dailyBonusAmount:Number(document.getElementById('set-bonus').value),adRewardAmount:Number(document.getElementById('set-ad-reward').value),dailyAdLimit:Number(document.getElementById('set-ad-limit').value),withdrawMethods:document.getElementById('set-withdraw-methods').value,adsgramBlockId:document.getElementById('set-adsgram-block').value};const d=await api('update_settings',{settings});state.settings=d.settings;applyPayload({...state,settings:d.settings});toast('Settings saved')}catch(e){toast(e.message)}};
document.querySelectorAll('nav button[data-section]').forEach(b=>b.onclick=()=>{if(b.classList.contains('hidden'))return;document.querySelectorAll('section').forEach(s=>s.classList.add('hidden'));document.getElementById(b.dataset.section).classList.remove('hidden');document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active'));b.classList.add('active')});

(async()=>{try{if(!tg)throw new Error('Telegram WebApp is not available');tg.ready();tg.expand();telegramInitData=tg.initData||'';if(!telegramInitData)throw new Error('Open this app from Telegram');await refresh()}catch(e){toast(e.message);document.getElementById('headerUserName').textContent=e.message}finally{document.getElementById('loading-spinner').style.display='none'}})();
</script>
</body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api") return handleApi(request, env);
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
};

// Deploy sync 2026-09-16
