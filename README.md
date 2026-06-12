# Seven Wonders — Match 3 (PWA)

An original, fan-made wonder-building match-3 game. All artwork is drawn on canvas in code
and the soundtrack is an original composition generated live with WebAudio — no commercial
assets are used anywhere in this project.

- **Live URL (after deploy):** https://surferyogi.github.io/seven-wonders/
- **Repo:** https://github.com/Surferyogi/seven-wonders
- **Supabase project:** `Seven Wonders` (`towegspmywsmhlsjrpty`, ap-southeast-1)
- **Version:** see `js/config.js` → `APP_VERSION` (format `vYYYY:MM:DD-HH:MM`, UTC)

---

## 1. Architecture

| Layer | What | Where |
|---|---|---|
| App shell | `index.html`, `styles.css`, `js/game.js` | GitHub Pages (static) |
| Music | `js/music.js` — original procedural WebAudio composition (D double-harmonic, ~80 BPM): drone, plucked melody with echo, frame-drum percussion. Zero audio files. | Client only |
| Offline | `sw.js` service worker + `manifest.webmanifest` | Client only |
| Persistence | `localStorage` (`sw_profile_v1`): player UUID, name, unlocked level, best score, audio settings | Device |
| Cloud sync | `js/cloud.js` → Supabase REST (`sw_saves`, `sw_scores`) | Supabase |

Local-first: the game is fully playable offline. Cloud calls fail silently when offline.

## 2. Supabase — already done for you

The following was applied today via migration `seven_wonders_init`:

- `sw_saves` — one row per device UUID (save sync across devices via the same UUID)
- `sw_scores` — append-only leaderboard (`score desc` index)
- RLS enabled on both; anon can **select/insert/update saves** and **select/insert scores**;
  no UPDATE/DELETE on scores (verified: anon DELETE affects 0 rows)
- `js/config.js` already contains the real project URL and the **publishable** key
  (`sb_publishable_…`) — this key is designed to be public in client code

**Honest security note:** there is no auth tier. The device UUID is the only "secret"
guarding a save row, and anyone with the public key can insert leaderboard rows. That is
an accepted trade-off for a casual personal game — do not store anything sensitive here.
The Supabase security advisor flags these open policies (expected), and also flags a
pre-existing `public.rls_auto_enable()` SECURITY DEFINER function in this project that
was there before this game's migration — review it separately.

## 3. GitHub — what you need to do (one-time, ~5 minutes)

```bash
cd ~/Downloads
unzip seven-wonders.zip && cd seven-wonders
git init
git add .
git commit -m "Seven Wonders v2026:06:12-10:14 — initial PWA release"
# create the repo first at github.com/new (name: seven-wonders, public)
git remote add origin https://github.com/Surferyogi/seven-wonders.git
git branch -M main
git push -u origin main
```

Then enable Pages: **repo → Settings → Pages → Source: Deploy from a branch →
Branch: `main` / `(root)` → Save.** The site appears at
`https://surferyogi.github.io/seven-wonders/` within a few minutes.

Requirements checklist (all already satisfied by this repo):
- HTTPS — GitHub Pages provides it (required for service workers/PWA install)
- All paths are **relative** (`./`), so the `/seven-wonders/` subpath works
- `manifest.webmanifest` + 192/512/maskable icons → installable on iOS/Android
- No build step, no Node, no dependencies — push and it runs

## 4. Install as an app

- **Android/Chrome:** visit the URL → "Add to Home screen" prompt
- **iOS/Safari:** Share → "Add to Home Screen"

## 5. Releasing updates (your standard loop)

```bash
cd ~/Downloads/seven-wonders && git pull
# ...edit...
# 1) bump APP_VERSION in js/config.js  (vYYYY:MM:DD-HH:MM)
# 2) bump CACHE_VERSION in sw.js       (must change or clients keep the old cache)
git add . && git commit -m "vYYYY:MM:DD-HH:MM — <what changed>" && git push
```

If a device seems stuck on an old version, use your usual cache-clear console command:
```js
(async()=>{const r=await navigator.serviceWorker.getRegistrations();for(const s of r)await s.unregister();const k=await caches.keys();for(const c of k)await caches.delete(c);location.reload(true)})()
```

SQL editor for this project:
https://supabase.com/dashboard/project/towegspmywsmhlsjrpty/sql

## 6. Game rules

Swap adjacent gems to match 3+. Matches shatter the stone tile beneath (dark tiles take
two hits). Cornerstones fall from above and are collected when they reach the glowing
bottom row. Clear **every tile** and deliver the **cornerstone quota** to finish a level.
14 levels build the 7 wonders (2 each). Match-4 forges a Bomb Gem (3×3), match-5 a Storm
Gem (row + column). Timed mode: matches restore time; bonus points for time remaining.
