CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  firstName TEXT NOT NULL DEFAULT '',
  lastName TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  photoUrl TEXT NOT NULL DEFAULT '',
  balance REAL NOT NULL DEFAULT 0,
  adsWatched INTEGER NOT NULL DEFAULT 0,
  daily_ad_date TEXT NOT NULL DEFAULT '',
  daily_ads_count INTEGER NOT NULL DEFAULT 0,
  lifetimeEarned REAL NOT NULL DEFAULT 0,
  lastBonusDate TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL,
  address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings(key,value) VALUES (
  'app',
  '{"currency":"BDT","dailyBonusAmount":0.1,"adRewardAmount":0.1,"dailyAdLimit":10,"withdrawMethods":"bKash:200, Nagad:200, Rocket:200, Binance:5","adsgramBlockId":"28773"}'
);
