# Zelvuno Telegram Mini App

Cloudflare Worker + D1 Telegram Mini App.

## Cloudflare secrets
- `BOT_TOKEN`: Telegram bot token (keep private)
- `ADMIN_CHAT_ID`: Telegram numeric user/chat ID used as admin identity

## Deploy
`npx wrangler deploy`

## D1 schema
Apply `schema.sql` to the existing D1 database if the tables are not already present.

## Important
Adsgram is triggered client-side after a successful ad display. A provider-side reward callback/proof should be added before treating ad rewards as fully trustless production revenue accounting.
