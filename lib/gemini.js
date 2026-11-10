// Google Gemini API (Interactions API): sahne görselleri ve hareketli sahne videoları.
// Not: Veo modelleri 22 Ekim 2026'da Gemini API'den kaldırıldı; yerine Google'ın önerdiği
// "gemini-omni-1.2-flash" kullanılır (görsel + prompt -> sesli video). Model adı .env ile değişir.
const fs = require('fs');

const BASE = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-nano-banana-2.1';
const VIDEO_MODEL = process.env.VEO_MODEL || 'gemini-omni-1.2-flash';
const API_REVISION = process.env.GEMINI_API_REVISION || '2026-05-20';

function isConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

function headers() {
  return {
    'x-goog-api-key': process.env.GEMINI_API_KEY,
    'Content-Type': 'application/json',
    'Api-Revision': API_REVISION,
  };
}

async function readError(res, what) {
  let detail = '';
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      detail = (j.error && (j.error.message || j.error.status)) || (j.errors && j.errors.map((e) => e.message).join('; ')) || body;
    } catch {
      detail = body;
    }
  } catch {
    detail = '';
  }
  detail = String(detail).slice(0, 400);
  if (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(detail)) return `Gemini: API anahtarı geçersiz (GEMINI_API_KEY).`;
  if (res.status === 403) return `Gemini: erişim reddedildi (anahtar yetkisi veya faturalandırma). ${detail}`;
  if (res.status === 404) return `Gemini: model bulunamadı (${what}). .env içindeki model adını kontrol edin. ${detail}`;
  if (res.status === 429) return `Gemini: istek sınırı aşıldı, biraz bekleyip tekrar deneyin. ${detail}`;
  return `Gemini ${what} hatası (${res.status}): ${detail}`;
}

async function postJson(url, body, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 300000);
  try {
    return await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: ctrl.signal });
  } catch (err) {
    throw new Error('Gemini bağlantı hatası: ' + (err.name === 'AbortError' ? 'zaman aşımı' : err.message));
  } finally {
    clearTimeout(t);
  }
}

// Interactions cevabından belirli türdeki (image/video) ilk medya bloğunu bulur.
function findMedia(interaction, type) {
  if (!interaction) return null;
  const direct = type === 'image' ? interaction.output_image : interaction.output_video;
  if (direct && (direct.data || direct.uri)) return direct;
  const steps = Array.isArray(interaction.steps) ? interaction.steps : [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.type !== 'model_output' || !Array.isArray(step.content)) continue;
    for (const block of step.content) {
      if (block.type === type && (block.data || block.uri)) return block;
    }
  }
  return null;
}

function interactionErrorText(interaction) {
  if (interaction && Array.isArray(interaction.errors) && interaction.errors.length) {
    return interaction.errors.map((e) => e.message || e.code).join('; ');
  }
  return '';
}

function mimeOf(file) {
  return /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg';
}

// Görsel üret -> dosyaya yaz (jpeg). refs: [{ name, file }] karakter referans fotoğrafları (isteğe bağlı).
async function generateImage(prompt, aspect, outFile, refs) {
  if (!isConfigured()) throw new Error('GEMINI_API_KEY tanımlı değil.');
  const input = [];
  const refList = (refs || []).filter((r) => r && r.file && fs.existsSync(r.file)).slice(0, 10);
  for (const r of refList) input.push({ type: 'image', data: fs.readFileSync(r.file).toString('base64'), mime_type: mimeOf(r.file) });
  let text = prompt;
  if (refList.length) {
    const names = refList.map((r, i) => `reference image ${i + 1} = ${r.name}`).join(', ');
    text = `Reference photos are attached: ${names}. Reproduce each referenced character's face, hair, skin tone and outfit faithfully from their reference photo; keep them recognizable as the same person. Do not copy the reference photo's background or framing.\n\n${prompt}`;
  }
  input.push({ type: 'text', text });
  const body = {
    model: IMAGE_MODEL,
    input,
    response_format: {
      type: 'image',
      mime_type: 'image/jpeg',
      aspect_ratio: aspect === '16:9' ? '16:9' : aspect === '1:1' ? '1:1' : '9:16',
      image_size: process.env.GEMINI_IMAGE_SIZE || '1K',
    },
    store: false,
  };
  const res = await postJson(`${BASE}/interactions`, body, 180000);
  if (!res.ok) throw new Error(await readError(res, 'görsel'));
  const interaction = await res.json();
  const media = findMedia(interaction, 'image');
  if (!media) {
    const why = interactionErrorText(interaction);
    throw new Error('Gemini görsel döndürmedi' + (why ? ': ' + why : ' (prompt güvenlik filtresine takılmış olabilir).'));
  }
  let buf;
  if (media.data) buf = Buffer.from(media.data, 'base64');
  else buf = await downloadFileUri(media.uri);
  fs.writeFileSync(outFile, buf);
  return outFile;
}

function fileIdFromUri(uri) {
  // "files/abc123" veya tam URL
  const m = String(uri).match(/files\/([^/:?]+)/);
  return m ? m[1] : null;
}

async function downloadFileUri(uri) {
  const id = fileIdFromUri(uri);
  if (!id) throw new Error('Gemini dosya adresi anlaşılamadı: ' + uri);
  // Dosya hazır olana kadar bekle
  for (let i = 0; i < 120; i++) {
    const r = await getRetry(`${BASE}/files/${id}`, { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY } });
    if (!r.ok) throw new Error(await readError(r, 'dosya durumu'));
    const info = await r.json();
    if (info.state === 'ACTIVE') break;
    if (info.state === 'FAILED') throw new Error('Gemini dosyası işlenemedi.');
    await sleep(5000);
  }
  const dl = await getRetry(`${BASE}/files/${id}:download?alt=media`, { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY }, redirect: 'follow' }, 300000);
  if (!dl.ok) throw new Error(await readError(dl, 'dosya indirme'));
  return Buffer.from(await dl.arrayBuffer());
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Video işi başladıktan sonraki istekler için: geçici ağ hatası, 429 ve 5xx'te bekleyip yeniden dene,
// her denemede zaman aşımı (varsayılan 60 sn). Aksi halde parası ödenen video tek bir kesintide kaybolur.
async function getRetry(url, options, timeoutMs = 60000, tries = 5) {
  for (let i = 1; ; i++) {
    let res, netErr;
    try { res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) }); } catch (err) { netErr = err; }
    const transient = netErr || res.status === 429 || res.status >= 500;
    if (!transient || i >= tries) { if (netErr) throw new Error('Gemini bağlantı hatası: ' + netErr.message); return res; }
    await sleep(Math.min(30000, 2000 * 2 ** (i - 1)));
  }
}

// Görsel + prompt -> video (image-to-video). Arka planda başlatılır, yoklanır, bitince indirilir.
// onStatus(text) ilerleme metni için isteğe bağlı.
// Gemini video süresi: 4 sn'ye sığan çekimler için 4s (yarı fiyat), aksi halde .env (8s).
function videoDuration(seconds) {
  if (process.env.GEMINI_VIDEO_DURATION_FIXED === '1') return process.env.GEMINI_VIDEO_DURATION || '8s';
  return seconds && seconds <= 4.5 ? '4s' : (process.env.GEMINI_VIDEO_DURATION || '8s');
}

// Gemini'nin içerik filtresi: etkileşim INVALID_ARGUMENT ile 'failed' döner (HTTP 200).
function filteredError(interaction) {
  const errs = (interaction && interaction.errors) || [];
  if (!errs.some((e) => e.code === 'INVALID_ARGUMENT' || /problem processing your request|safety|blocked/i.test(e.message || ''))) return null;
  const err = new Error('Gemini bu sahneyi reddetti (içerik filtresi: bağırma, tehdit, korkmuş kişi, hakaret gibi ifadeler).');
  err.code = 'filtered';
  return err;
}

async function imageToVideo(imageFile, prompt, aspect, outFile, onStatus, opts) {
  if (!isConfigured()) throw new Error('GEMINI_API_KEY tanımlı değil.');
  const imageB64 = fs.readFileSync(imageFile).toString('base64');
  const body = {
    model: VIDEO_MODEL,
    input: [
      { type: 'image', data: imageB64, mime_type: mimeOf(imageFile) },
      { type: 'text', text: prompt },
    ],
    generation_config: { video_config: { task: 'image_to_video' } },
    response_format: {
      type: 'video',
      aspect_ratio: aspect === '16:9' ? '16:9' : '9:16',
      resolution: (opts && opts.resolution) || process.env.GEMINI_VIDEO_RESOLUTION || '720p',
      duration: videoDuration(opts && opts.seconds),
    },
    background: true,
  };

  if (onStatus) onStatus('Video başlatılıyor');
  let res = await postJson(`${BASE}/interactions`, body, 120000);
  let interaction;
  if (res.status === 400) {
    // Arka plan modu desteklenmiyorsa eşzamanlı dene
    const text = await res.text();
    if (/background/i.test(text)) {
      delete body.background;
      if (onStatus) onStatus('Video üretiliyor (eşzamanlı)');
      res = await postJson(`${BASE}/interactions`, body, 600000);
      if (!res.ok) throw new Error(await readError(res, 'video'));
      interaction = await res.json();
    } else {
      throw new Error(`Gemini video hatası (400): ${text.slice(0, 400)}`);
    }
  } else if (!res.ok) {
    throw new Error(await readError(res, 'video'));
  } else {
    interaction = await res.json();
  }

  // Yokla
  const started = Date.now();
  while (interaction.status === 'in_progress' || interaction.status === 'requires_continuation') {
    if (Date.now() - started > 20 * 60 * 1000) throw new Error('Gemini video üretimi zaman aşımına uğradı (20 dk).');
    await sleep(5000);
    if (onStatus) onStatus('Video üretiliyor (' + Math.round((Date.now() - started) / 1000) + ' sn)');
    const r = await getRetry(`${BASE}/interactions/${interaction.id}`, { headers: headers() });
    if (!r.ok) throw new Error(await readError(r, 'video durumu'));
    interaction = await r.json();
  }
  if (interaction.status === 'failed' || interaction.status === 'cancelled') {
    const f = filteredError(interaction);
    if (f) throw f;
    throw new Error('Gemini video üretimi başarısız: ' + (interactionErrorText(interaction) || interaction.status));
  }
  const media = findMedia(interaction, 'video');
  if (!media) {
    const why = interactionErrorText(interaction);
    throw new Error('Gemini video döndürmedi' + (why ? ': ' + why : ' (prompt güvenlik filtresine takılmış olabilir).'));
  }
  if (onStatus) onStatus('Video indiriliyor');
  let buf;
  if (media.data) buf = Buffer.from(media.data, 'base64');
  else buf = await downloadFileUri(media.uri);
  fs.writeFileSync(outFile, buf);
  return outFile;
}

module.exports = { isConfigured, generateImage, imageToVideo, IMAGE_MODEL, VIDEO_MODEL };
