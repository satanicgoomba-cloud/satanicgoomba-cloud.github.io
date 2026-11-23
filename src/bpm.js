// Real tempo for Spotify songs without analysing Spotify's audio: look the recording up in Deezer's
// public catalogue by ISRC (the industry ID Spotify also gives us) and read its BPM.
//
// Deezer's API has no CORS, only JSONP (it answers with a script). So the lookup runs inside a
// sandboxed iframe with an opaque origin: Deezer's script can't touch this page, its storage or the
// Spotify login. Only the ISRC goes out; only a number comes back.

const CACHE = 'bb.bpmdb';
let frame = null, frameReady = null, seq = 0;
const waiting = new Map();

function read() { try { return JSON.parse(localStorage.getItem(CACHE)) || {}; } catch { return {}; } }
export function cachedBpm(trackId) { const v = read()[trackId]; return v && v.bpm > 0 ? v.bpm : 0; }

function ensureFrame() {
  if (frameReady) return frameReady;
  frameReady = new Promise((resolve) => {
    frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts'); // no allow-same-origin: opaque origin
    frame.style.display = 'none';
    frame.srcdoc = `<!doctype html><script>
      addEventListener('message', (e) => {
        const id = Number(e.data && e.data.id), isrc = String(e.data && e.data.isrc || '');
        if (!/^[A-Z0-9]{12}$/i.test(isrc)) return parent.postMessage({ id, bpm: 0 }, '*');
        const cb = 'cb' + id, s = document.createElement('script');
        const done = (bpm) => { delete window[cb]; s.remove(); parent.postMessage({ id, bpm }, '*'); };
        window[cb] = (d) => done(Number(d && d.bpm) || 0);
        s.onerror = () => done(0);
        s.src = 'https://api.deezer.com/track/isrc:' + isrc + '?output=jsonp&callback=' + cb;
        document.head.appendChild(s);
      });
      parent.postMessage({ ready: true }, '*');
    <\/script>`;
    addEventListener('message', (e) => {
      if (!frame || e.source !== frame.contentWindow || !e.data) return;
      if (e.data.ready) return resolve();
      const w = waiting.get(e.data.id);
      if (w) { waiting.delete(e.data.id); w(Number(e.data.bpm) || 0); }
    });
    document.body.appendChild(frame);
  });
  return frameReady;
}

/** BPM from Deezer (cached per track). Resolves 0 if unknown. Never takes longer than timeoutMs. */
export async function lookupBpm(track, timeoutMs = 3000) {
  if (!track || !track.isrc) return 0;
  const db = read();
  if (db[track.id]) return db[track.id].bpm || 0;
  const timeout = new Promise((r) => setTimeout(() => r(-1), timeoutMs));
  const ask = (async () => {
    await ensureFrame();
    const id = ++seq;
    return new Promise((r) => { waiting.set(id, r); frame.contentWindow.postMessage({ id, isrc: track.isrc }, '*'); });
  })();
  let bpm = await Promise.race([ask, timeout]);
  if (bpm < 0) return 0; // timed out: don't cache, try again next time
  if (!(bpm >= 60 && bpm <= 220)) bpm = 0;
  if (bpm) { while (bpm < 75) bpm *= 2; while (bpm > 185) bpm /= 2; }
  db[track.id] = { bpm: Math.round(bpm * 100) / 100 };
  localStorage.setItem(CACHE, JSON.stringify(db));
  return db[track.id].bpm;
}
