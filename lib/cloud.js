// Supabase bulut eşitleme: kullanıcı girişi (e-posta + şifre), videoların ve kütüphanenin
// kullanıcıya özel buluta kaydedilmesi / geri alınması. Veri modeli yerelde aynı kalır (data/);
// bulut yalnızca yedek + bilgisayarlar arası taşıma katmanıdır.
//   Tablolar: public.videos (user_id, id, name, data, manifest), public.library (user_id, data, manifest)
//   Depo:     storage bucket "videos", yol: <user_id>/<video_id>/<dosya> ve <user_id>/library/<dosya>
//   Şema:     supabase/schema.sql (RLS: herkes yalnızca kendi satırlarını / dosyalarını görür)
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const store = require('./store');

const URL = process.env.SUPABASE_URL || '';
const ANON = process.env.SUPABASE_ANON_KEY || '';
const BUCKET = process.env.SUPABASE_BUCKET || 'videos';
const SKIP = /^(final\.tmp\.mp4|dis-arac-paketi\.zip|\.pano\.txt)$/i;

function isConfigured() { return !!(URL && ANON); }
function need() { if (!isConfigured()) throw new Error('Supabase ayarlı değil (.env: SUPABASE_URL, SUPABASE_ANON_KEY).'); }
function turkishError(err) {
  const m = (err && err.message) || String(err);
  if (/Invalid login credentials/i.test(m)) return 'E-posta ya da şifre yanlış.';
  if (/Email not confirmed/i.test(m)) return 'E-posta henüz doğrulanmamış; gelen kutusundaki bağlantıya tıklayın (ya da Supabase panelinden kullanıcıyı onaylayın).';
  if (/User already registered/i.test(m)) return 'Bu e-posta zaten kayıtlı; giriş yapın.';
  if (/Password should be/i.test(m)) return 'Şifre en az 6 karakter olmalı.';
  if (/JWT|token|session/i.test(m) && /expired|invalid|missing/i.test(m)) return 'Oturum süresi dolmuş; yeniden giriş yapın.';
  if (/row-level security|violates/i.test(m)) return 'Bulut izni reddedildi (şema/RLS kurulu mu?). ' + m;
  if (/relation .* does not exist|Could not find the table/i.test(m)) return 'Bulut tabloları kurulu değil: supabase/schema.sql dosyasını Supabase SQL editöründe çalıştırın.';
  if (/Bucket not found/i.test(m)) return `Depo kovası "${BUCKET}" yok: supabase/schema.sql çalıştırılmalı.`;
  return 'Bulut: ' + m;
}

function anonClient() { need(); return createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } }); }

// Oturumlu istemci: tarayıcının sakladığı access/refresh token ile. Dönen session yenilenmiş olabilir.
async function userClient(session) {
  need();
  if (!session || !session.access_token) throw new Error('Giriş yapılmamış.');
  const c = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token || '' });
  if (error) throw new Error(turkishError(error));
  return { c, session: pack(data.session), user: data.user };
}
function pack(s) { return s ? { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, user: s.user ? { id: s.user.id, email: s.user.email } : null } : null; }

async function signIn(email, password) {
  const c = anonClient();
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(turkishError(error));
  return pack(data.session);
}
async function signUp(email, password) {
  const c = anonClient();
  const { data, error } = await c.auth.signUp({ email, password });
  if (error) throw new Error(turkishError(error));
  return { session: pack(data.session), needsConfirm: !data.session };
}

// --- dosya yardımcıları ---
function manifestOf(dir) {
  const m = {};
  if (!fs.existsSync(dir)) return m;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isFile() && !SKIP.test(f) && f !== 'video.json') m[f] = st.size;
  }
  return m;
}
function mime(f) { return /\.mp4$/i.test(f) ? 'video/mp4' : /\.mp3$/i.test(f) ? 'audio/mpeg' : /\.jpe?g$/i.test(f) ? 'image/jpeg' : /\.png$/i.test(f) ? 'image/png' : /\.webp$/i.test(f) ? 'image/webp' : /\.json$/i.test(f) ? 'application/json' : /\.txt$/i.test(f) ? 'text/plain' : 'application/octet-stream'; }

async function uploadDir(c, prefix, dir, remoteManifest, onProgress) {
  const local = manifestOf(dir);
  const uploaded = [];
  const names = Object.keys(local);
  for (let i = 0; i < names.length; i++) {
    const f = names[i];
    if (remoteManifest && remoteManifest[f] === local[f]) continue; // aynı boyut: değişmemiş say
    if (onProgress) onProgress(`${f} (${i + 1}/${names.length})`);
    const { error } = await c.storage.from(BUCKET).upload(`${prefix}/${f}`, fs.readFileSync(path.join(dir, f)), { upsert: true, contentType: mime(f) });
    if (error) throw new Error(turkishError(error));
    uploaded.push(f);
  }
  // Uzakta olup yerelde artık olmayanları sil
  const stale = Object.keys(remoteManifest || {}).filter((f) => !(f in local));
  if (stale.length) await c.storage.from(BUCKET).remove(stale.map((f) => `${prefix}/${f}`));
  return { manifest: local, uploaded: uploaded.length, removed: stale.length };
}
async function downloadDir(c, prefix, dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const [f, size] of Object.entries(manifest || {})) {
    const p = path.join(dir, f);
    if (fs.existsSync(p) && fs.statSync(p).size === size) continue;
    const { data, error } = await c.storage.from(BUCKET).download(`${prefix}/${f}`);
    if (error) throw new Error(turkishError(error) + ` (${f})`);
    fs.writeFileSync(p, Buffer.from(await data.arrayBuffer()));
    n++;
  }
  return n;
}

// --- videolar ---
async function listVideos(session) {
  const { c, session: s } = await userClient(session);
  const { data, error } = await c.from('videos').select('id,name,updated_at,manifest,summary').order('updated_at', { ascending: false });
  if (error) throw new Error(turkishError(error));
  const local = new Set(store.listVideos().map((v) => v.id));
  return { session: s, videos: (data || []).map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at, files: Object.keys(r.manifest || {}).length, bytes: Object.values(r.manifest || {}).reduce((a, b) => a + b, 0), local: local.has(r.id), summary: r.summary || null })) };
}
async function pushVideo(session, vid, onProgress) {
  const v = store.getVideo(vid);
  if (!v) throw new Error('Video bulunamadı');
  const { c, session: s, user } = await userClient(session);
  const { data: row } = await c.from('videos').select('manifest').eq('id', vid).maybeSingle();
  const r = await uploadDir(c, `${user.id}/${vid}`, store.videoDir(vid), row && row.manifest, onProgress);
  const summary = { shotCount: v.shots.length, aspect: v.plan ? v.plan.aspect : v.aspect, final: !!v.final, toplam_usd: (v.costs || []).reduce((n, x) => n + (x.usd || 0), 0) };
  const { error } = await c.from('videos').upsert({ id: vid, user_id: user.id, name: v.name || vid, data: v, manifest: r.manifest, summary, updated_at: new Date().toISOString() });
  if (error) throw new Error(turkishError(error));
  store.updateVideo(vid, (vv) => { vv.cloudAt = Date.now(); });
  return { session: s, uploaded: r.uploaded, removed: r.removed, files: Object.keys(r.manifest).length };
}
async function pullVideo(session, vid) {
  const { c, session: s, user } = await userClient(session);
  const { data: row, error } = await c.from('videos').select('data,manifest').eq('id', vid).maybeSingle();
  if (error) throw new Error(turkishError(error));
  if (!row) throw new Error('Bulutta böyle bir video yok.');
  const dir = store.videoDir(vid);
  fs.mkdirSync(dir, { recursive: true });
  const n = await downloadDir(c, `${user.id}/${vid}`, dir, row.manifest);
  const v = Object.assign({}, row.data, { busy: false, producing: false, assembling: false, planning: false, cloudAt: Date.now() });
  if (Array.isArray(v.shots)) v.shots.forEach((sh) => { sh.busy = false; });
  fs.writeFileSync(path.join(dir, 'video.json'), JSON.stringify(v, null, 2));
  return { session: s, downloaded: n, files: Object.keys(row.manifest || {}).length };
}
async function deleteVideo(session, vid) {
  const { c, session: s, user } = await userClient(session);
  const { data: row } = await c.from('videos').select('manifest').eq('id', vid).maybeSingle();
  if (row && row.manifest && Object.keys(row.manifest).length) await c.storage.from(BUCKET).remove(Object.keys(row.manifest).map((f) => `${user.id}/${vid}/${f}`));
  const { error } = await c.from('videos').delete().eq('id', vid);
  if (error) throw new Error(turkishError(error));
  return { session: s };
}

// --- kütüphane ---
async function pushLibrary(session, onProgress) {
  const lib = store.getLibrary();
  const { c, session: s, user } = await userClient(session);
  const { data: row } = await c.from('library').select('manifest').eq('user_id', user.id).maybeSingle();
  const r = await uploadDir(c, `${user.id}/library`, store.LIB_FILES, row && row.manifest, onProgress);
  const { error } = await c.from('library').upsert({ user_id: user.id, data: lib, manifest: r.manifest, updated_at: new Date().toISOString() });
  if (error) throw new Error(turkishError(error));
  return { session: s, uploaded: r.uploaded, files: Object.keys(r.manifest).length };
}
async function pullLibrary(session) {
  const { c, session: s, user } = await userClient(session);
  const { data: row, error } = await c.from('library').select('data,manifest,updated_at').eq('user_id', user.id).maybeSingle();
  if (error) throw new Error(turkishError(error));
  if (!row) throw new Error('Bulutta kütüphane yok.');
  const n = await downloadDir(c, `${user.id}/library`, store.LIB_FILES, row.manifest);
  store.updateLibrary((lib) => { Object.assign(lib, row.data); });
  return { session: s, downloaded: n, updatedAt: row.updated_at };
}
async function libraryInfo(session) {
  const { c, session: s, user } = await userClient(session);
  const { data: row } = await c.from('library').select('updated_at,manifest').eq('user_id', user.id).maybeSingle();
  return { session: s, exists: !!row, updatedAt: row ? row.updated_at : null, files: row ? Object.keys(row.manifest || {}).length : 0 };
}

module.exports = { isConfigured, signIn, signUp, listVideos, pushVideo, pullVideo, deleteVideo, pushLibrary, pullLibrary, libraryInfo, turkishError, BUCKET };
