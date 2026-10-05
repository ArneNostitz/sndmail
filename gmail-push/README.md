# snd Gmail push bridge

Small deployment service for Gmail `users.watch` / Google Pub/Sub notifications.
It is intentionally separate from the Tauri app so it can run on Coolify.

## What it does

- accepts Gmail watch registrations from snd;
- renews watches before their seven-day expiry;
- receives authenticated Pub/Sub push messages;
- exposes a server-sent events stream for connected snd clients;
- persists registrations in a mounted JSON data file.

The service does not receive or store mailbox contents. Gmail notifications only contain an account email and history ID; snd still performs the incremental Gmail API sync.

## Setup

1. Create a Google Cloud Pub/Sub topic, for example `projects/PROJECT_ID/topics/snd-gmail`.
2. Grant Gmail's publishing service account permission to publish to that topic:
   `serviceAccount:gmail-api-push@system.gserviceaccount.com` with `roles/pubsub.publisher`.
3. Create a Pub/Sub push subscription targeting `https://YOUR_HOST/pubsub`.
4. Deploy this directory with Docker Compose and set `PUSH_SHARED_SECRET`.
5. In snd Settings → Google API → Gmail push relay, enter the service URL, the shared secret, and the full Pub/Sub topic name. snd registers each active Gmail account and renews its watch automatically.

The relay does not receive or store mailbox contents. snd performs the targeted History API sync after each notification.

`GET /health` returns `{ "ok": true, "version": "..." }`. Set `APP_VERSION` in Coolify to the deployed commit or release identifier when you need to verify the running image.
