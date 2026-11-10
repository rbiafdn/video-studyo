// Maliyet takibi: fiyat tablosu (prices.json), çekim bazında tahmin, gerçek kayıt, toplamlar, bütçe.
const fs = require('fs');
const path = require('path');
const store = require('./store');

const PRICES_FILE = path.join(__dirname, '..', 'prices.json');
let cache = { mtime: 0, prices: null };

function prices() {
  try {
    const st = fs.statSync(PRICES_FILE);
    if (!cache.prices || st.mtimeMs !== cache.mtime) cache = { mtime: st.mtimeMs, prices: JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8')) };
  } catch (err) { if (!cache.prices) throw new Error('prices.json okunamadı: ' + err.message); }
  return cache.prices;
}
const pick = (table, key) => (table ? table[key] || table._varsayilan || { tahmini: true } : { tahmini: true });
const round = (n) => Math.round(n * 10000) / 10000;

function activeModels() {
  return {
    claude: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
    claudeHard: process.env.CLAUDE_MODEL_HARD || 'claude-opus-5-5',
    image: process.env.GEMINI_IMAGE_MODEL || 'gemini-nano-banana-2.1',
    imageSize: process.env.GEMINI_IMAGE_SIZE || '1K',
    video: process.env.VEO_MODEL || 'gemini-omni-1.2-flash',
    videoRes: process.env.GEMINI_VIDEO_RESOLUTION || '720p',
    tts: process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2',
    dialogue: process.env.ELEVENLABS_DIALOGUE_MODEL || 'eleven_v4',
    avatar: process.env.FAL_AVATAR_MODEL || 'fal-ai/kling-video/ai-avatar/v2/standard',
    seedance: process.env.SEEDANCE_MODEL || 'bytedance/seedance-2.5/us/image-to-video',
    seedanceRes: process.env.SEEDANCE_RESOLUTION || '720p',
  };
}

// --- Birim fiyatlar ----------------------------------------------------------------
function claudeCost(model, usage) {
  const p = pick(prices().claude, model);
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  return { usd: round((inTok / 1e6) * (p.girdi || 0) + ((usage.output_tokens || 0) / 1e6) * (p.cikti || 0)), tahmini: !!p.tahmini };
}
function imageCost(model, size) {
  const p = pick(prices().gemini_gorsel, model);
  const key = String(size || '1K').toUpperCase();
  return { usd: round(p[key] != null ? p[key] : p['1K'] || 0), tahmini: !!p.tahmini || p[key] == null };
}
function geminiVideoCost(model, seconds, res) {
  const p = pick(prices().gemini_video, model);
  const key = String(res || '720p').toLowerCase();
  return { usd: round((p[key] != null ? p[key] : p['720p'] || 0) * seconds), tahmini: !!p.tahmini || p[key] == null };
}
function creditsUsd(kredi) { return round((kredi / 1000) * (prices().elevenlabs.usd_per_1000_kredi.usd || 0)); }
function ttsCost(model, characters) {
  const p = pick(prices().elevenlabs.tts_kredi_per_karakter, model);
  const kredi = Math.ceil(characters * (p.kredi || 1));
  return { kredi, usd: creditsUsd(kredi), tahmini: true };
}
function stsCost(seconds) {
  const kredi = Math.ceil((seconds / 60) * (prices().elevenlabs.sts_kredi_per_dakika.kredi || 1000));
  return { kredi, usd: creditsUsd(kredi), tahmini: true };
}
function sfxCost(seconds) {
  const kredi = Math.ceil(seconds * ((prices().elevenlabs.sfx_kredi_per_saniye || {}).kredi || 40));
  return { kredi, usd: creditsUsd(kredi), tahmini: true };
}
function musicCost(seconds) {
  const p = prices().elevenlabs.muzik_kredi_per_dakika || { kredi: 2000 };
  const kredi = Math.ceil((seconds / 60) * (p.kredi || 2000));
  return { kredi, usd: creditsUsd(kredi), tahmini: true };
}
function falCost(model, seconds) {
  const p = pick(prices().fal, model);
  return { usd: round((p.saniye || 0) * seconds), tahmini: !!p.tahmini };
}
function seedanceCost(model, seconds, res) {
  const p = pick(prices().fal_seedance, model);
  const key = String(res || '720p').toLowerCase();
  return { usd: round((p[key] != null ? p[key] : p['720p'] || 0) * seconds), tahmini: !!p.tahmini || p[key] == null };
}

// --- Kayıt ve toplamlar ------------------------------------------------------------
// sid: çekim id'si, null = video düzeyi (plan, müzik, efekt)
function record(vid, sid, entry) {
  const e = Object.assign({ at: new Date().toISOString(), usd: 0, kredi: 0, tahmini: false }, entry);
  e.usd = round(e.usd || 0);
  store.updateVideo(vid, (v) => {
    if (sid == null) { (v.costs = v.costs || []).push(e); return; }
    const s = v.shots.find((x) => x.id === sid);
    if (s) (s.costs = s.costs || []).push(e);
  });
  return e;
}
const emptyTotals = () => ({ toplam_usd: 0, servisler: { claude: { usd: 0 }, gemini: { usd: 0 }, elevenlabs: { usd: 0, kredi: 0, karakter: 0 }, fal: { usd: 0 } } });
function addEntry(t, e) {
  const s = t.servisler[e.servis] || (t.servisler[e.servis] = { usd: 0 });
  s.usd = round(s.usd + (e.usd || 0));
  if (e.kredi) s.kredi = (s.kredi || 0) + e.kredi;
  if (e.servis === 'elevenlabs' && e.birim === 'karakter') s.karakter = (s.karakter || 0) + (e.miktar || 0);
  t.toplam_usd = round(t.toplam_usd + (e.usd || 0));
}
function shotTotals(shot) { const t = emptyTotals(); for (const e of shot.costs || []) addEntry(t, e); return t; }
function summarize(video) {
  const t = emptyTotals();
  for (const e of video.costs || []) addEntry(t, e);
  for (const s of video.shots || []) for (const e of s.costs || []) addEntry(t, e);
  return t;
}

// --- Tahminler ---------------------------------------------------------------------
const exists = (vid, name) => !!name && fs.existsSync(store.videoFile(vid, name));
const speechChars = (shot) => (shot.dialogue || []).reduce((n, d) => n + (d.line || '').length, 0);
const voChars = (shot) => (shot.voiceover || []).reduce((n, d) => n + (d.line || '').length, 0);

// Çekim tahmini: adım adım kalemler (image, audio, video, fixvoice, voiceover)
function estimateShot(video, shot) {
  const m = activeModels();
  const est = {};
  const tool = shot.tool;
  if (tool !== 'text_card') est.image = Object.assign({ servis: 'gemini', model: m.image }, imageCost(m.image, m.imageSize));
  if (tool === 'avatar') {
    const chars = speechChars(shot);
    est.audio = Object.assign({ servis: 'elevenlabs', model: m.dialogue, karakter: chars }, ttsCost(m.dialogue, chars));
    const secs = shot.audioDuration || Math.max(3, Math.ceil(chars / 14) + 1);
    est.video = Object.assign({ servis: 'fal', model: m.avatar, saniye: secs }, falCost(m.avatar, secs));
  } else if (tool === 'gemini' || tool === 'motion') {
    const secs = 8;
    est.video = Object.assign({ servis: 'gemini', model: m.video, saniye: secs }, geminiVideoCost(m.video, secs, m.videoRes));
    const speakers = new Set((shot.dialogue || []).map((d) => d.speaker));
    if (speakers.size === 1) est.fixvoice = Object.assign({ servis: 'elevenlabs', model: 'voice-changer', saniye: shot.rawDuration || secs }, stsCost(shot.rawDuration || secs));
  } else if (tool === 'flow') {
    est.video = { servis: 'flow', usd: 0, kredi: 0, tahmini: true };
    const speakers = new Set((shot.dialogue || []).map((d) => d.speaker));
    if (speakers.size === 1) est.fixvoice = Object.assign({ servis: 'elevenlabs', model: 'voice-changer', saniye: shot.rawDuration || 8 }, stsCost(shot.rawDuration || 8));
  } else if (tool === 'seedance') {
    const secs = Math.min(8, Math.max(4, Math.round(shot.duration || 5)));
    est.video = Object.assign({ servis: 'fal', model: m.seedance, saniye: secs }, seedanceCost(m.seedance, secs, m.seedanceRes));
  } else if (tool === 'text_card') {
    est.video = { servis: 'ffmpeg', usd: 0, kredi: 0, tahmini: false };
  }
  const vc = voChars(shot);
  if (vc) est.voiceover = Object.assign({ servis: 'elevenlabs', model: m.tts, karakter: vc }, ttsCost(m.tts, vc));
  return est;
}

function sumItems(items) {
  const t = { usd: 0, kredi: 0, tahmini: true, kalemler: items };
  for (const i of items) { t.usd = round(t.usd + (i.usd || 0)); t.kredi += i.kredi || 0; }
  return t;
}

// Bir adımın maliyeti: 'auto' eksikler, 'all' baştan, veya tek adım adı
function estimateStep(video, shot, step) {
  const est = estimateShot(video, shot);
  const have = (n) => exists(video.id, n);
  const items = [];
  const redo = step === 'all';
  const push = (k) => { if (est[k]) items.push(est[k]); };
  if (step === 'image' || redo || (step === 'auto' && est.image && !have(shot.image))) push('image');
  if (step === 'audio' || redo || (step === 'auto' && est.audio && !have(shot.audio))) push('audio');
  if (step === 'voiceover' || redo || (step === 'auto' && est.voiceover && !(shot.voFiles && shot.voFiles.length))) push('voiceover');
  const needVideo = step === 'video' || redo || (step === 'auto' && !have(shot.video));
  if (needVideo && !(step === 'auto' && have(shot.raw))) push('video');
  if (needVideo || step === 'fixvoice') push('fixvoice');
  return sumItems(items);
}

// Ses katmanları (müzik/efekt üretimi)
function estimateAudioLayers(video) {
  const items = [];
  for (const a of video.audio || []) {
    if (a.file || a.type === 'silence' || (a.source || '').startsWith('library:')) continue;
    const secs = Math.max(1, (a.end || 0) - (a.start || 0));
    if (a.type === 'music') items.push(Object.assign({ servis: 'elevenlabs', model: 'music', saniye: secs }, musicCost(secs)));
    else if (a.type === 'sfx') items.push(Object.assign({ servis: 'elevenlabs', model: 'sfx', saniye: Math.min(30, secs) }, sfxCost(Math.min(30, secs))));
  }
  return items;
}

function estimateAll(video) {
  const items = [];
  for (const s of video.shots || []) { if (exists(video.id, s.video) && (!s.voiceover.length || (s.voFiles && s.voFiles.length))) continue; items.push(...estimateStep(video, s, 'auto').kalemler); }
  items.push(...estimateAudioLayers(video));
  return sumItems(items);
}

function estimatePlan(settings, assets, video) {
  const m = activeModels();
  const a = prices().tahmin_varsayimlari || {};
  const ctx = JSON.stringify(assets || {}).length + (settings.notes || '').length;
  const len = (video.script || '').length + ctx;
  const inTok = (a.plan_girdi_token_sabit || 1500) + 1200 + len * (a.plan_girdi_token_per_karakter || 0.35);
  const target = video.targetSeconds || Math.max(30, Math.round(len / 12));
  const shots = Math.max(4, Math.round(target / 7));
  const outTok = (a.plan_cikti_token_sabit || 800) + shots * 650;
  const model = video.hardPlanning ? m.claudeHard : m.claude;
  return { servis: 'claude', model, usd: claudeCost(model, { input_tokens: inTok, output_tokens: outTok }).usd, kredi: 0, tahmini: true };
}

function decorate(settings, assets, video) {
  const v = JSON.parse(JSON.stringify(video));
  v.maliyet = summarize(v);
  v.tahmin = { tumunu: estimateAll(v), plan: estimatePlan(settings, assets, v), katmanlar: sumItems(estimateAudioLayers(v)) };
  for (const s of v.shots || []) { s.maliyet = shotTotals(s); s.tahmin = estimateShot(v, s); s.tahminToplam = sumItems(Object.values(s.tahmin)); }
  return v;
}

function budgetWarning(video, extraUsd) {
  const max = Number(video.budget);
  if (!(max > 0)) return null;
  const cur = summarize(video).toplam_usd;
  if (cur + extraUsd > max) return `Bu işlem toplamı bütçenin üstüne çıkaracak: şimdiye kadar $${cur.toFixed(2)} + tahmini $${extraUsd.toFixed(2)} > bütçe $${max.toFixed(2)}. Yine de devam edilsin mi?`;
  return null;
}

module.exports = {
  prices, activeModels,
  claudeCost, imageCost, geminiVideoCost, ttsCost, stsCost, sfxCost, musicCost, falCost, seedanceCost,
  record, summarize, shotTotals, estimateShot, estimateStep, estimateAll, estimateAudioLayers, estimatePlan, decorate, budgetWarning,
};
