# Telegram Mini App — Cloudflare Worker + D1

This project converts the original PHP backend to a Cloudflare Worker (`index.js`), keeps the existing Mini App UI/admin panel, and moves persistent data from JSON files to Cloudflare D1.

## 1. Create the D1 database

```bash
npx wrangler d1 create telegram-miniapp-db
```

Copy the returned database ID into `wrangler.jsonc`.

## 2. Create the tables

```bash
npx wrangler d1 execute telegram-miniapp-db --remote --file=./schema.sql
```

## 3. Add secrets

Never put the bot token in `index.js`, GitHub, or `wrangler.jsonc`.

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put ADMIN_CHAT_ID
```

`ADMIN_CHAT_ID` should be your Telegram numeric admin ID.

Cloudflare documents Worker secrets as the place for API keys/auth tokens.

## 4. Deploy

```bash
npx wrangler deploy
```

The Worker URL can then be used as the Telegram Mini App URL.

## 5. Telegram

The client sends `Telegram.WebApp.initData` to the Worker. The Worker validates the HMAC signature before accepting the Telegram user. Do not use `initDataUnsafe` as authentication.

## Important

- The admin panel is still inside the Mini App, but admin authorization is now checked server-side.
- Bot token is no longer returned to the browser/admin panel.
- User balances and withdrawals are stored in D1 instead of JSON files.
- Withdraw cancellation refunds the pending amount.
- Daily ad limits are enforced server-side.
- The existing Adsgram UI remains connected.

For production, ad rewards should additionally be tied to a provider-side completion/callback mechanism if the ad provider exposes one; a browser promise alone should not be treated as a payment-grade proof.
