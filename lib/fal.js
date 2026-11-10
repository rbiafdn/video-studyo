// fal.ai kuyruk (queue) API'si: sabit kamerada konuşan karakter (görsel + ses -> dudak uyumlu video).
// Varsayılan model Kling AI Avatar v2 (standard). Yedek: ByteDance OmniHuman
// (InfiniteTalk fal.ai'de artık desteklenmiyor / deprecated).
const fs = require('fs');
const path = require('path');

const QUEUE_BASE = (process.env.FAL_QUEUE_BASE || 'https://queue.fal.run').replace(/\/$/, '');
const AVATAR_MODEL = process.env.FAL_AVATAR_MODEL || 'fal-ai/kling-video/ai-avatar/v2/standard';
const FALLBACK_MODEL = process.env.FAL_AVATAR_FALLBACK_MODEL || 'fal-ai/bytedance/omnihuman';

function isConfigured() {
  return !!process.env.FAL_KEY;
}

function headers() {
  return { Authorization: 'Key ' + process.env.FAL_KEY, 'Content-Type': 'application/json' };
}

async function readError(res, what) {
  let detail = '';
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      const d = j.detail;
      if (typeof d === 'string') detail = d;
      else if (Array.isArray(d)) detail = d.map((x) => x.msg || JSON.stringify(x)).join('; ');
      else detail = j.message || body;
    } catch {
      detail = body;
    }
  } catch {
    detail = '';
  }
  detail = String(detail).slice(0, 400);
  if (/exhausted balance|locked|insufficient/i.test(detail)) return 'fal.ai: hesap bakiyesi bitmiş. fal.ai/dashboard/billing adresinden kredi yükleyin (anahtar geçerli).';
  if (res.status === 401 || res.status === 403) return 'fal.ai: API anahtarı geçersiz veya yetkisiz (FAL_KEY). ' + detail;
  if (res.status === 404) return `fal.ai: model bulunamadı (${what}). FAL_AVATAR_MODEL adını kontrol edin. ${detail}`;
  if (res.status === 422) return `fal.ai: girdi kabul edilmedi (${what}). ${detail}`;
  if (res.status === 429) return 'fal.ai: istek sınırı aşıldı, biraz sonra tekrar deneyin.';
  return `fal.ai ${what} hatası (${res.status}): ${detail}`;
}

async function doFetch(url, options, what) {
  try {
    return await fetch(url, options);
  } catch (err) {
    throw new Error(`fal.ai bağlantı hatası (${what}): ${err.message}`);
  }
}

function toDataUri(file) {
  const ext = path.extname(file).toLowerCase();
  const mime =
    ext === '.png' ? 'image/png'
    : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : ext === '.wav' ? 'audio/wav'
    : ext === '.m4a' ? 'audio/mp4'
    : ext === '.mp3' ? 'audio/mpeg'
    : 'application/octet-stream';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Kuyruğa gönder, durumu yokla, bitince sonucu döndür.
async function runQueued(model, input, onStatus) {
  const submit = await doFetch(`${QUEUE_BASE}/${model}`, { method: 'POST', headers: headers(), body: JSON.stringify(input) }, 'gönderim');
  if (!submit.ok) throw new Error(await readError(submit, 'gönderim'));
  const job = await submit.json();
  // Durum/sonuç adresleri sadece owner/app kullanır; fal bunları cevapta hazır verir.
  const parts = model.split('/');
  const appBase = `${QUEUE_BASE}/${parts[0]}/${parts[1]}/requests/${job.request_id}`;
  const statusUrl = job.status_url || `${appBase}/status`;
  const resultUrl = job.response_url || appBase;

  const started = Date.now();
  for (;;) {
    if (Date.now() - started > 20 * 60 * 1000) throw new Error('fal.ai işi zaman aşımına uğradı (20 dk).');
    const st = await doFetch(statusUrl, { headers: headers() }, 'durum');
    if (!st.ok) throw new Error(await readError(st, 'durum'));
    const status = await st.json();
    if (status.status === 'COMPLETED') break;
    if (onStatus) {
      const secs = Math.round((Date.now() - started) / 1000);
      onStatus(status.status === 'IN_QUEUE' ? `Kuyrukta (sıra ${status.queue_position ?? '?'})` : `Video üretiliyor (${secs} sn)`);
    }
    await sleep(4000);
  }
  const rs = await doFetch(resultUrl, { headers: headers() }, 'sonuç');
  if (!rs.ok) throw new Error(await readError(rs, 'sonuç'));
  return rs.json();
}

async function downloadTo(url, outFile) {
  const res = await doFetch(url, { redirect: 'follow' }, 'indirme');
  if (!res.ok) throw new Error(`fal.ai video indirilemedi (${res.status}).`);
  fs.writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
  return outFile;
}

function buildInput(model, imageUri, audioUri, prompt) {
  const input = { image_url: imageUri, audio_url: audioUri };
  // Kling AI Avatar ve OmniHuman v1.5 "prompt" kabul eder; eski OmniHuman etmez.
  if (!/bytedance\/omnihuman$/.test(model) && prompt) input.prompt = prompt;
  return input;
}

// Görsel + ses -> konuşan video. Birincil model başarısız olursa yedek model denenir.
async function avatarVideo(imageFile, audioFile, prompt, outFile, onStatus) {
  if (!isConfigured()) throw new Error('FAL_KEY tanımlı değil.');
  const imageUri = toDataUri(imageFile);
  const audioUri = toDataUri(audioFile);
  const models = [AVATAR_MODEL];
  if (FALLBACK_MODEL && FALLBACK_MODEL !== AVATAR_MODEL) models.push(FALLBACK_MODEL);

  let lastErr;
  for (const model of models) {
    try {
      if (onStatus) onStatus(`Avatar gönderiliyor (${model})`);
      const result = await runQueued(model, buildInput(model, imageUri, audioUri, prompt), onStatus);
      const url = result && result.video && result.video.url;
      if (!url) throw new Error('fal.ai sonuçta video adresi yok: ' + JSON.stringify(result).slice(0, 300));
      if (onStatus) onStatus('Video indiriliyor');
      await downloadTo(url, outFile);
      return { file: outFile, model, duration: typeof result.duration === 'number' ? result.duration : null };
    } catch (err) {
      lastErr = err;
      if (model !== models[models.length - 1] && onStatus) onStatus('Birincil model başarısız, yedek deneniyor');
    }
  }
  throw lastErr;
}

// --- Seedance (ByteDance) image-to-video -------------------------------------------
// Varsayılan: bytedance/seedance-2.5/us/image-to-video (en güncel). Girdi: ilk kare + prompt.
// En-boy oranı image-to-video'da görselden alınır ("auto"); süre 4-30 sn arasında seçilebilir.
const SEEDANCE_MODEL = process.env.SEEDANCE_MODEL || 'bytedance/seedance-2.5/us/image-to-video';
const SEEDANCE_RESOLUTION = process.env.SEEDANCE_RESOLUTION || '720p';

async function seedanceVideo(imageFile, prompt, seconds, outFile, onStatus, opts) {
  if (!isConfigured()) throw new Error('FAL_KEY tanımlı değil.');
  const input = {
    prompt,
    image_url: toDataUri(imageFile),
    resolution: SEEDANCE_RESOLUTION,
    duration: String(Math.round(seconds)),
    generate_audio: !(opts && opts.generateAudio === false),
  };
  if (onStatus) onStatus(`Seedance'a gönderiliyor (${Math.round(seconds)} sn)`);
  const result = await runQueued(SEEDANCE_MODEL, input, onStatus);
  const url = result && result.video && result.video.url;
  if (!url) throw new Error('fal.ai Seedance sonucunda video adresi yok: ' + JSON.stringify(result).slice(0, 300));
  if (onStatus) onStatus('Video indiriliyor');
  await downloadTo(url, outFile);
  return { file: outFile, model: SEEDANCE_MODEL, resolution: SEEDANCE_RESOLUTION };
}

module.exports = { isConfigured, avatarVideo, seedanceVideo, AVATAR_MODEL, FALLBACK_MODEL, SEEDANCE_MODEL, SEEDANCE_RESOLUTION };
