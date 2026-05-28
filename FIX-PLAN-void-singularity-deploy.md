# FIX-PLAN: Void Singularity Omega — Deployment Fix

## Problem
Game loads HTML but JS bundles fail — browser rejects ES modules served as `text/html`.

## Root Cause
Nginx root was `/var/www/rasputin/game/` which contained an old 213KB inline build.
The omega build was deployed to `/var/www/rasputin/game/omega/` (subdirectory) — never served.

## Fix Applied
1. Removed old `index.html` from nginx root
2. Copied omega `dist/` contents directly to `/var/www/rasputin/game/`
3. Removed orphaned `/omega/` subdirectory
4. Cleaned stale assets (only current `index-DMY_hO5D.js` remains)

## Verification
- `curl -sI` confirms `text/javascript` for `.js` ✅
- `curl -sI` confirms `text/html` for `.html` ✅
- Script src resolves: `./assets/index-DMY_hO5D.js` ✅
- Game boots at https://game.rasputin.studio ✅

## Files
- `/var/www/rasputin/game/index.html` — omega build entry
- `/var/www/rasputin/game/assets/` — 7 files (current build only)
- Nginx config: `/etc/nginx/conf.d/game-rasputin-studio.conf`
