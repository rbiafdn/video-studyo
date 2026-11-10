// ElevenLabs: ses listesi, metinden konuşma (TTS) ve ses değiştirme (Speech-to-Speech / Voice Changer).
const fs = require('fs');
const path = require('path');

const BASE = (process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/$/, '');
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2';
// Diyaloglar: köşeli parantez duygu etiketlerini ([shouting], [crying], [whispers]) destekleyen model
const DIALOGUE_MODEL = process.env.ELEVENLABS_DIALOGUE_MODEL || 'eleven_v4';
const STS_MODEL = process.env.ELEVENLABS_STS_MODEL || 'eleven_multilingual_sts_v2';
const MUSIC_MODEL = process.env.ELEVENLABS_MUSIC_MODEL || 'music_v2_5';
const SFX_MODEL = process.env.ELEVENLABS_SFX_MODEL || 'eleven_text_to_sound_v3';
const OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128';

// Türkçe duygu notunu ElevenLabs ses etiketine çevirir (v3/v4 köşeli parantez etiketleri)
const EMOTION_TAGS = [
  [/bağır|haykır|çığlık/i, '[shouting]'],
  [/hıçkır|ağla|gözyaş/i, '[crying]'],
  [/fısıl/i, '[whispers]'],
  [/kırık|titre|boğuk/i, '[sad, shaky voice]'],
  [/gül|kahkaha/i, '[laughs]'],
  [/iç çek|nefes/i, '[sighs]'],
  [/öfke|kızgın|sinir/i, '[angry]'],
  [/heyecan|coşku/i, '[excited]'],
  [/alay|iğne/i, '[sarcastic]'],
  [/merak/i, '[curious]'],
  [/sakin|yumuşak/i, '[calm, soft]'],
  [/hüzün|üzgün|kederli/i, '[sad]'],
  [/kork|panik|endişe/i, '[fearful, trembling]'],
  [/yorgun|bitkin/i, '[tired]'],
  [/nefret|tiksin/i, '[disgusted]'],
];
function emotionTag(emotion) {
  const e = String(emotion || '').trim();
  if (!e) return '';
  for (const [re, tag] of EMOTION_TAGS) if (re.test(e)) return tag;
  if (/^[a-z ,]+$/i.test(e)) return `[${e.toLowerCase()}]`;
  return '';
}

function isConfigured() {
  return !!process.env.ELEVENLABS_API_KEY;
}

function keyHeader() {
  return { 'xi-api-key': process.env.ELEVENLABS_API_KEY };
}

async function readError(res, what) {
  let detail = '';
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      const d = j.detail;
      if (typeof d === 'string') detail = d;
      else if (d && d.message) detail = d.message;
      else if (Array.isArray(d)) detail = d.map((x) => x.msg || JSON.stringify(x)).join('; ');
      else detail = body;
    } catch {
      detail = body;
    }
  } catch {
    detail = '';
  }
  detail = String(detail).slice(0, 400);
  if (res.status === 401) return 'ElevenLabs: API anahtarı geçersiz (ELEVENLABS_API_KEY).';
  if (res.status === 402) return 'ElevenLabs: kota veya bakiye yetersiz. ' + detail;
  if (res.status === 404) return `ElevenLabs: ses bulunamadı (${what}). ${detail}`;
  if (res.status === 429) return 'ElevenLabs: istek sınırı aşıldı, biraz sonra tekrar deneyin.';
  return `ElevenLabs ${what} hatası (${res.status}): ${detail}`;
}

async function doFetch(url, options, what) {
  try {
    return await fetch(url, options);
  } catch (err) {
    throw new Error(`ElevenLabs bağlantı hatası (${what}): ${err.message}`);
  }
}

let voiceCache = { at: 0, voices: [] };

// Hesaptaki tüm sesler (v2, sayfalı). 5 dakika önbellek.
async function listVoices(force) {
  if (!isConfigured()) throw new Error('ELEVENLABS_API_KEY tanımlı değil.');
  if (!force && voiceCache.voices.length && Date.now() - voiceCache.at < 5 * 60 * 1000) return voiceCache.voices;
  const voices = [];
  let token = null;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ page_size: '100', include_total_count: 'false' });
    if (token) params.set('next_page_token', token);
    const res = await doFetch(`${BASE}/v2/voices?${params}`, { headers: keyHeader() }, 'ses listesi');
    if (!res.ok) throw new Error(await readError(res, 'ses listesi'));
    const data = await res.json();
    for (const v of data.voices || []) {
      voices.push({
        voice_id: v.voice_id,
        name: v.name,
        category: v.category || '',
        labels: v.labels || {},
        preview_url: v.preview_url || null,
      });
    }
    if (!data.has_more || !data.next_page_token) break;
    token = data.next_page_token;
  }
  voiceCache = { at: Date.now(), voices };
  return voices;
}

// Metinden ses (mp3) -> dosya. opts: { model, emotion } (emotion verilirse etiket başa eklenir)
async function textToSpeech(text, voiceId, outFile, opts) {
  if (!isConfigured()) throw new Error('ELEVENLABS_API_KEY tanımlı değil.');
  if (!voiceId) throw new Error('Bu karakter için ElevenLabs sesi seçilmemiş.');
  if (!text || !text.trim()) throw new Error('Replik boş.');
  const model = (opts && opts.model) || TTS_MODEL;
  const tag = opts && opts.emotion ? emotionTag(opts.emotion) : '';
  const body = {
    text: tag && /eleven_v[34]/.test(model) ? `${tag} ${text}` : text,
    model_id: model,
    voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
  };
  // multilingual_v2 ve v3/v4 language_code kabul etmez; flash modellerinde Türkçe'yi belirt
  if (/flash/.test(model)) body.language_code = 'tr';
  const res = await doFetch(
    `${BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(OUTPUT_FORMAT)}`,
    { method: 'POST', headers: { ...keyHeader(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    'TTS'
  );
  if (!res.ok) throw new Error(await readError(res, 'TTS'));
  fs.writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
  return outFile;
}

// Ses değiştirme: verilen ses dosyasındaki konuşmayı seçilen karakter sesine çevirir (mp3)
async function speechToSpeech(audioFile, voiceId, outFile) {
  if (!isConfigured()) throw new Error('ELEVENLABS_API_KEY tanımlı değil.');
  if (!voiceId) throw new Error('Bu karakter için ElevenLabs sesi seçilmemiş.');
  const buf = fs.readFileSync(audioFile);
  const ext = path.extname(audioFile).toLowerCase();
  const mime = ext === '.wav' ? 'audio/wav' : ext === '.m4a' ? 'audio/mp4' : 'audio/mpeg';
  const form = new FormData();
  form.append('audio', new Blob([buf], { type: mime }), 'input' + (ext || '.mp3'));
  form.append('model_id', STS_MODEL);
  form.append('remove_background_noise', 'false');
  form.append('voice_settings', JSON.stringify({ stability: 0.5, similarity_boost: 0.8, style: 0, use_speaker_boost: true }));
  const res = await doFetch(
    `${BASE}/v1/voice-changer/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(OUTPUT_FORMAT)}`,
    { method: 'POST', headers: keyHeader(), body: form },
    'ses değiştirme'
  );
  if (!res.ok) throw new Error(await readError(res, 'ses değiştirme'));
  fs.writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
  return outFile;
}

// Müzik üret (mp3). seconds: 3..300
async function music(prompt, seconds, outFile, instrumental) {
  if (!isConfigured()) throw new Error('ELEVENLABS_API_KEY tanımlı değil.');
  const ms = Math.round(Math.min(300, Math.max(3, seconds)) * 1000);
  const res = await doFetch(`${BASE}/v1/music?output_format=${encodeURIComponent(OUTPUT_FORMAT)}`, {
    method: 'POST', headers: { ...keyHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, music_length_ms: ms, model_id: MUSIC_MODEL, force_instrumental: instrumental !== false }),
  }, 'müzik');
  if (!res.ok) throw new Error(await readError(res, 'müzik'));
  fs.writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
  return outFile;
}

// Ses efekti üret (mp3). seconds: 0.5..30
async function soundEffect(text, seconds, outFile) {
  if (!isConfigured()) throw new Error('ELEVENLABS_API_KEY tanımlı değil.');
  const body = { text, model_id: SFX_MODEL, prompt_influence: 0.3 };
  if (seconds) body.duration_seconds = Math.min(30, Math.max(0.5, seconds));
  const res = await doFetch(`${BASE}/v1/sound-generation?output_format=${encodeURIComponent(OUTPUT_FORMAT)}`, {
    method: 'POST', headers: { ...keyHeader(), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, 'ses efekti');
  if (!res.ok) throw new Error(await readError(res, 'ses efekti'));
  fs.writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
  return outFile;
}

// Hesap bakiyesi: dönem içinde kullanılan / izin verilen karakter (kredi) sayısı
async function subscription() {
  if (!isConfigured()) throw new Error('ELEVENLABS_API_KEY tanımlı değil.');
  const res = await doFetch(`${BASE}/v1/user/subscription`, { headers: keyHeader() }, 'abonelik');
  if (!res.ok) throw new Error(await readError(res, 'abonelik'));
  const d = await res.json();
  return {
    tier: d.tier || '',
    status: d.status || '',
    used: d.character_count || 0,
    limit: d.character_limit || 0,
    remaining: Math.max(0, (d.character_limit || 0) - (d.character_count || 0)),
    resetAt: d.next_character_count_reset_unix ? new Date(d.next_character_count_reset_unix * 1000).toISOString() : null,
  };
}

module.exports = { isConfigured, listVoices, textToSpeech, speechToSpeech, music, soundEffect, subscription, emotionTag, TTS_MODEL, DIALOGUE_MODEL, STS_MODEL, MUSIC_MODEL, SFX_MODEL };
