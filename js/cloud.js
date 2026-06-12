/* Seven Wonders — Supabase sync (plain REST, no SDK)
   Tables: sw_saves (device-UUID keyed save), sw_scores (append-only leaderboard).
   Every call fails silently offline; the game is local-first. */
(function () {
  'use strict';
  const C = window.SW_CONFIG;
  const BASE = C.SUPABASE_URL + '/rest/v1';
  const HEADERS = {
    apikey: C.SUPABASE_KEY,
    Authorization: 'Bearer ' + C.SUPABASE_KEY,
    'Content-Type': 'application/json',
  };

  async function req(path, opts = {}, timeoutMs = 6000) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(BASE + path, {
        ...opts,
        headers: { ...HEADERS, ...(opts.headers || {}) },
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(to);
    }
  }

  window.SWCloud = {
    online: () => navigator.onLine !== false,

    async loadSave(id) {
      const rows = await req(`/sw_saves?id=eq.${encodeURIComponent(id)}&select=*`);
      return rows && rows[0] ? rows[0] : null;
    },

    async upsertSave(save) {
      return req('/sw_saves?on_conflict=id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          id: save.id,
          name: save.name,
          level_reached: save.level_reached,
          best_score: save.best_score,
          settings: save.settings || {},
          updated_at: new Date().toISOString(),
        }),
      });
    },

    async submitScore(row) {
      return req('/sw_scores', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          player_id: row.player_id,
          name: row.name,
          score: row.score,
          level: row.level,
          mode: row.mode,
        }),
      });
    },

    async topScores(limit = 15) {
      return req(`/sw_scores?select=name,score,level,mode,created_at&order=score.desc&limit=${limit}`);
    },

    /* admin: deletes all leaderboard rows; PIN is verified server-side in Postgres */
    async resetLeaderboard(pin) {
      return req('/rpc/sw_reset_leaderboard', {
        method: 'POST',
        body: JSON.stringify({ p_pin: pin }),
      });
    },
  };
})();
