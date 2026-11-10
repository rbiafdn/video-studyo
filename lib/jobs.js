// Üretim akışı (otomatik yönetmen): çekim adımları, dış ses, ses katmanları, elle klip, birleştirme.
// İşler arka planda çalışır, ilerleme video.json'a yazılır; aynı çekimde aynı anda iki iş çalışmaz.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const gemini = require('./gemini');
const eleven = require('./elevenlabs');
const fal = require('./fal');
const media = require('./media');
const costs = require('./costs');
const claude = require('./claude');
const look = require('./look');

const shotLocks = new Set();
const videoLocks = new Set();
const DEFAULT_MOTION_PROMPT = 'The person speaks naturally to the camera with subtle head movement, natural blinking and facial expressions. Static camera, no camera movement.';
const key = (vid, sid) => `${vid}:${sid}`;

function fileNames(sid) {
  return {
    image: `shot-${sid}-image.jpg`, audio: `shot-${sid}-dialogue.mp3`, raw: `shot-${sid}-raw.mp4`,
    clipAudio: `shot-${sid}-clip-audio.mp3`, fixedAudio: `shot-${sid}-fixed-audio.mp3`, video: `shot-${sid}-video.mp4`,
    vo: (i) => `shot-${sid}-vo-${i}.mp3`,
  };
}
const exists = (vid, name) => !!name && fs.existsSync(store.videoFile(vid, name));

function patchShot(vid, sid, patch) {
  return store.updateVideo(vid, (v) => {
    const s = v.shots.find((x) => x.id === sid);
    if (!s) throw new Error('Çekim bulunamadı');
    Object.assign(s, patch);
  });
}
function ctx(vid, sid) {
  const lib = store.getLibrary();
  const video = store.getVideo(vid);
  if (!video) throw new Error('Video bulunamadı');
  const shot = sid != null ? video.shots.find((x) => x.id === sid) : null;
  if (sid != null && !shot) throw new Error('Çekim bulunamadı');
  return { lib, video, shot };
}
const setStatus = (vid, sid, status) => patchShot(vid, sid, { status });

function computeStatus(vid, shot) {
  if (shot.video && exists(vid, shot.video)) return shot.manual ? 'Hazır (elle yüklendi)' : 'Hazır';
  if (shot.raw && exists(vid, shot.raw)) return 'Klip var, ses işleniyor';
  if (shot.tool === 'flow' && shot.image && exists(vid, shot.image)) return 'Klip bekleniyor (dış araç)';
  if (shot.audio && exists(vid, shot.audio)) return 'Ses hazır';
  if (shot.image && exists(vid, shot.image)) return 'Görsel hazır';
  return 'Bekliyor';
}

const findChar = (lib, name) => (lib.characters || []).find((c) => c.name === name);
const findLoc = (lib, name) => (lib.locations || []).find((l) => l.name === name);
function narratorVoice(lib, name) {
  const n = (lib.narrators || []).find((x) => x.name === name) || (lib.narrators || [])[0];
  return n ? n.voiceId : '';
}
function refImages(lib, shot) {
  const refs = [];
  for (const name of shot.characters || []) {
    const c = findChar(lib, name);
    if (c) for (const p of (c.photos || []).slice(0, 3)) refs.push({ name: c.name, file: store.libFile(p) });
  }
  const loc = findLoc(lib, shot.location);
  if (loc) for (const p of (loc.photos || []).slice(0, 2)) refs.push({ name: `location "${loc.name}"`, file: store.libFile(p) });
  return refs;
}
function singleSpeaker(shot) {
  const names = new Set((shot.dialogue || []).map((d) => (d.speaker || '').trim()).filter(Boolean));
  return names.size === 1 ? [...names][0] : null;
}

// Görsel promptunun başına kütüphanedeki GÜNCEL karakter/mekân tariflerini koyar (plan sonrası değişiklikler de geçerli olsun).
function withDescriptions(lib, shot) {
  const lines = [];
  for (const name of shot.characters || []) {
    const ch = findChar(lib, name);
    if (ch && ch.description) lines.push(`- ${ch.name}: ${ch.description}`);
  }
  const loc = findLoc(lib, shot.location);
  if (loc && loc.description) lines.push(`- Location "${loc.name}": ${loc.description}`);
  if (!lines.length) return shot.image_prompt;
  return 'Fixed descriptions (follow exactly, together with the reference photos):\n' + lines.join('\n') + '\n\n' + shot.image_prompt;
}

// --- Çekim adımları -------------------------------------------------------------------

async function stepImage(vid, sid) {
  const { lib, video, shot } = ctx(vid, sid);
  if (!shot.image_prompt || !shot.image_prompt.trim()) throw new Error('Görsel promptu boş.');
  setStatus(vid, sid, 'Görsel üretiliyor');
  const n = fileNames(sid);
  await gemini.generateImage(look.imagePrompt(withDescriptions(lib, shot), look.forVideo(store.getSettings(), video)), video.plan.aspect, store.videoFile(vid, n.image), refImages(lib, shot));
  patchShot(vid, sid, { image: n.image, imageAt: Date.now(), imageManual: false });
  const m = costs.activeModels();
  costs.record(vid, sid, { servis: 'gemini', model: gemini.IMAGE_MODEL, miktar: 1, birim: 'görsel', boyut: m.imageSize, ...costs.imageCost(gemini.IMAGE_MODEL, m.imageSize) });
}

// Avatar çekimi için diyalog sesi (tek konuşan; duygu etiketi ile)
async function stepAudio(vid, sid) {
  const { lib, shot } = ctx(vid, sid);
  const speaker = singleSpeaker(shot);
  if (!speaker) throw new Error('Avatar çekiminde tek bir konuşan olmalı.');
  const c = findChar(lib, speaker);
  if (!c || !c.voiceId) throw new Error(`"${speaker}" için ElevenLabs sesi seçilmemiş (Kütüphane → Karakterler).`);
  const text = shot.dialogue.map((d) => d.line).join(' ');
  setStatus(vid, sid, 'Ses üretiliyor');
  const n = fileNames(sid);
  const out = store.videoFile(vid, n.audio);
  await eleven.textToSpeech(text, c.voiceId, out, { model: eleven.DIALOGUE_MODEL, emotion: shot.dialogue[0].emotion });
  patchShot(vid, sid, { audio: n.audio, audioAt: Date.now(), audioDuration: await media.duration(out) });
  costs.record(vid, sid, { servis: 'elevenlabs', model: eleven.DIALOGUE_MODEL, miktar: text.length, birim: 'karakter', ...costs.ttsCost(eleven.DIALOGUE_MODEL, text.length) });
}

// Dış ses satırları (anlatıcı)
async function stepVoiceover(vid, sid) {
  const { lib, shot } = ctx(vid, sid);
  if (!shot.voiceover || !shot.voiceover.length) return;
  setStatus(vid, sid, 'Dış ses üretiliyor');
  const n = fileNames(sid);
  const files = [];
  for (let i = 0; i < shot.voiceover.length; i++) {
    const vo = shot.voiceover[i];
    const voiceId = narratorVoice(lib, vo.narrator);
    if (!voiceId) throw new Error(`Anlatıcı sesi bulunamadı ("${vo.narrator}"). Kütüphane → Dış ses bölümünden ekleyin.`);
    const out = store.videoFile(vid, n.vo(i));
    await eleven.textToSpeech(vo.line, voiceId, out, { model: eleven.TTS_MODEL, emotion: vo.style });
    files.push({ file: n.vo(i), duration: await media.duration(out), text: vo.line });
    costs.record(vid, sid, { servis: 'elevenlabs', model: eleven.TTS_MODEL, miktar: vo.line.length, birim: 'karakter', not: 'Dış ses', ...costs.ttsCost(eleven.TTS_MODEL, vo.line.length) });
  }
  patchShot(vid, sid, { voFiles: files, voAt: Date.now() });
}

async function stepTextCard(vid, sid) {
  const { video, shot } = ctx(vid, sid);
  const item = (shot.onscreen_text || [])[0] || { text: shot.description, style: 'hook' };
  setStatus(vid, sid, 'Yazı kartı hazırlanıyor');
  const n = fileNames(sid);
  await media.textCard(store.videoDir(vid), store.videoFile(vid, n.video), { text: item.text, style: item.style, seconds: shot.duration, aspect: video.plan.aspect });
  patchShot(vid, sid, { video: n.video, videoAt: Date.now(), manual: false, actualDuration: shot.duration });
}

async function stepAvatarVideo(vid, sid) {
  const { shot } = ctx(vid, sid);
  if (!exists(vid, shot.image)) throw new Error('Önce görsel üretilmeli.');
  if (!exists(vid, shot.audio)) throw new Error('Önce ses üretilmeli.');
  setStatus(vid, sid, 'Avatar videosu üretiliyor');
  const n = fileNames(sid);
  const out = store.videoFile(vid, n.video);
  const r = await fal.avatarVideo(store.videoFile(vid, shot.image), store.videoFile(vid, shot.audio), shot.motion_prompt || DEFAULT_MOTION_PROMPT, out, (t) => setStatus(vid, sid, t));
  const dur = r.duration || (await media.duration(out));
  patchShot(vid, sid, { video: n.video, videoAt: Date.now(), manual: false, actualDuration: dur });
  const seconds = Math.round(dur * 10) / 10;
  costs.record(vid, sid, { servis: 'fal', model: r.model, miktar: seconds, birim: 'saniye', ...costs.falCost(r.model, seconds) });
}

async function stepGeminiVideo(vid, sid) {
  const { video, shot } = ctx(vid, sid);
  if (!exists(vid, shot.image)) throw new Error('Önce görsel üretilmeli.');
  if (!shot.video_prompt || !shot.video_prompt.trim()) throw new Error('Video promptu boş.');
  const n = fileNames(sid);
  const out = store.videoFile(vid, n.raw);
  const imageFile = store.videoFile(vid, shot.image);
  const opts = { seconds: Math.max(Number(shot.duration) || 0, claude.speechSeconds(shot.dialogue)), resolution: video.resolution || undefined };
  const FILTER_HELP = " Yumuşatılmış prompt da reddedildi. Çözüm: aracı Avatar yapın (karaktere ElevenLabs sesi atayın) ya da video promptunu düzenleyin.";
  // Bu prompt için daha önce yumuşatılmış sürüm üretildiyse doğrudan onu kullan.
  const settings = look.forVideo(store.getSettings(), video);
  let prompt = shot.video_prompt_soft && shot.video_prompt_soft_for === shot.video_prompt ? shot.video_prompt_soft : shot.video_prompt;
  let fixNote = prompt === shot.video_prompt ? '' : 'Yumuşatılmış video promptu kullanıldı (Gemini içerik filtresi).';
  setStatus(vid, sid, 'Video üretiliyor (Gemini)');
  try {
    await gemini.imageToVideo(imageFile, look.videoPrompt(prompt, settings), video.plan.aspect, out, (t) => setStatus(vid, sid, t), opts);
  } catch (err) {
    if (err.code !== 'filtered' || prompt !== shot.video_prompt) {
      if (err.code === 'filtered') err.message += FILTER_HELP;
      throw err;
    }
    setStatus(vid, sid, 'Gemini reddetti, prompt yumuşatılıyor (Claude)');
    const soft = await claude.softenVideoPrompt(shot.video_prompt);
    const u = soft.usage;
    costs.record(vid, sid, { servis: 'claude', model: u.model, birim: 'token', miktar: u.input_tokens + u.output_tokens, girdi_token: u.input_tokens, cikti_token: u.output_tokens, ...costs.claudeCost(u.model, u), not: 'Prompt yumuşatma' });
    patchShot(vid, sid, { video_prompt_soft: soft.prompt, video_prompt_soft_for: shot.video_prompt });
    prompt = soft.prompt;
    fixNote = 'Gemini ilk promptu reddetti; Claude yumuşattı, ikinci deneme kabul edildi.';
    setStatus(vid, sid, 'Video üretiliyor (Gemini, 2. deneme)');
    try {
      await gemini.imageToVideo(imageFile, look.videoPrompt(prompt, settings), video.plan.aspect, out, (t) => setStatus(vid, sid, t), opts);
    } catch (err2) {
      if (err2.code === 'filtered') err2.message += FILTER_HELP;
      throw err2;
    }
  }
  const rawDuration = await media.duration(out);
  patchShot(vid, sid, { raw: n.raw, rawAt: Date.now(), rawDuration, video: null, manual: false, fixNote });
  const m = costs.activeModels();
  const billed = Math.round((rawDuration || 8) * 10) / 10;
  const vres = video.resolution || m.videoRes;
  costs.record(vid, sid, { servis: 'gemini', model: gemini.VIDEO_MODEL, miktar: billed, birim: 'saniye', cozunurluk: vres, ...costs.geminiVideoCost(gemini.VIDEO_MODEL, billed, vres) });
}

async function stepSeedanceVideo(vid, sid) {
  const { shot } = ctx(vid, sid);
  if (!exists(vid, shot.image)) throw new Error('Önce görsel üretilmeli.');
  if (!shot.video_prompt || !shot.video_prompt.trim()) throw new Error('Video promptu boş.');
  setStatus(vid, sid, 'Video üretiliyor (Seedance)');
  const n = fileNames(sid);
  const out = store.videoFile(vid, n.video);
  const seconds = Math.min(8, Math.max(4, Math.round(shot.duration || 5)));
  const r = await fal.seedanceVideo(store.videoFile(vid, shot.image), look.videoPrompt(shot.video_prompt, look.forVideo(store.getSettings(), ctx(vid, sid).video)), seconds, out, (t) => setStatus(vid, sid, t), { generateAudio: false });
  const dur = await media.duration(out);
  patchShot(vid, sid, { video: n.video, videoAt: Date.now(), manual: false, actualDuration: dur });
  const billed = Math.round((dur || seconds) * 10) / 10;
  costs.record(vid, sid, { servis: 'fal', model: r.model, miktar: billed, birim: 'saniye', cozunurluk: r.resolution, ...costs.seedanceCost(r.model, billed, r.resolution) });
}

// Hareketli çekimin ham klibini bitirir: tek konuşan varsa sesi karakterin sabit sesine çevirir
async function stepFinishMotion(vid, sid) {
  const { lib, shot } = ctx(vid, sid);
  if (!exists(vid, shot.raw)) throw new Error('İşlenecek klip yok.');
  const n = fileNames(sid);
  const rawPath = store.videoFile(vid, shot.raw);
  const videoPath = store.videoFile(vid, n.video);
  const speaker = singleSpeaker(shot);
  const c = speaker ? findChar(lib, speaker) : null;
  let note = '';
  if (shot.fixVoice === false) note = 'Ses düzeltme kapalı, orijinal ses bırakıldı.';
  else if (!(shot.dialogue || []).length) note = 'Konuşma yok, klip olduğu gibi kullanıldı.';
  else if (!speaker) note = 'Birden fazla konuşan var, orijinal ses bırakıldı.';
  else if (!c || !c.voiceId) note = `"${speaker}" için ses seçilmediğinden orijinal ses bırakıldı.`;
  else if (!(await media.hasAudio(rawPath))) note = 'Klipte ses yok, olduğu gibi kullanıldı.';
  else {
    setStatus(vid, sid, 'Ses ayrılıyor');
    const clipAudio = store.videoFile(vid, n.clipAudio);
    await media.extractAudio(rawPath, clipAudio);
    setStatus(vid, sid, 'Ses karakter sesine çevriliyor');
    const fixed = store.videoFile(vid, n.fixedAudio);
    try { await eleven.speechToSpeech(clipAudio, c.voiceId, fixed); }
    catch (err) {
      // Ses çevrilemezse çekim düşmesin: orijinal ses kalsın, not bırak.
      fs.copyFileSync(rawPath, videoPath);
      patchShot(vid, sid, { video: n.video, videoAt: Date.now(), actualDuration: await media.duration(videoPath), fixNote: 'Ses çevrilemedi, orijinal ses bırakıldı: ' + (err && err.message ? err.message : err) });
      return;
    }
    const seconds = Math.round(((await media.duration(clipAudio)) || 0) * 10) / 10;
    costs.record(vid, sid, { servis: 'elevenlabs', model: eleven.STS_MODEL, miktar: seconds, birim: 'saniye', ...costs.stsCost(seconds) });
    setStatus(vid, sid, 'Ses klibe ekleniyor');
    await media.replaceAudio(rawPath, fixed, videoPath);
    patchShot(vid, sid, { video: n.video, videoAt: Date.now(), actualDuration: await media.duration(videoPath), fixNote: `Ses "${speaker}" sesine çevrildi.` });
    return;
  }
  fs.copyFileSync(rawPath, videoPath);
  patchShot(vid, sid, { video: n.video, videoAt: Date.now(), actualDuration: await media.duration(videoPath), fixNote: note });
}

// --- Çekim çalıştırıcı ---------------------------------------------------------------------
// step: auto | all | image | audio | voiceover | video | fixvoice
async function runShot(vid, sid, step) {
  const k = key(vid, sid);
  if (shotLocks.has(k)) throw new Error('Bu çekimde zaten bir iş çalışıyor.');
  shotLocks.add(k);
  patchShot(vid, sid, { busy: true, error: null });
  try {
    const { shot } = ctx(vid, sid);
    const have = (n) => exists(vid, n);
    const redo = step === 'all';
    const tool = shot.tool;
    if (tool !== 'text_card' && (step === 'image' || (redo && !shot.imageManual) || (step === 'auto' && !have(shot.image)))) await stepImage(vid, sid);
    if (shot.voiceover && shot.voiceover.length && (step === 'voiceover' || redo || (step === 'auto' && !(shot.voFiles && shot.voFiles.length)))) await stepVoiceover(vid, sid);
    if (tool === 'avatar' && (step === 'audio' || redo || (step === 'auto' && !have(shot.audio)))) await stepAudio(vid, sid);
    const needVideo = step === 'video' || redo || (step === 'auto' && !have(shot.video));
    if (step === 'fixvoice') await stepFinishMotion(vid, sid);
    else if (needVideo) {
      if (tool === 'text_card') await stepTextCard(vid, sid);
      else if (tool === 'avatar') await stepAvatarVideo(vid, sid);
      else if (tool === 'seedance') await stepSeedanceVideo(vid, sid);
      else if (tool === 'gemini') {
        const cur = ctx(vid, sid).shot;
        if (!(step === 'auto' && have(cur.raw))) await stepGeminiVideo(vid, sid);
        await stepFinishMotion(vid, sid);
      } else if (tool === 'flow') {
        const cur = ctx(vid, sid).shot;
        if (have(cur.raw)) await stepFinishMotion(vid, sid);
        // klip yoksa: dış araçtan klip bekleniyor (durum aşağıda hesaplanır)
      }
    }
    const fresh = ctx(vid, sid).shot;
    patchShot(vid, sid, { status: computeStatus(vid, fresh) });
  } catch (err) {
    patchShot(vid, sid, { status: 'Hata', error: err.message || String(err) });
  } finally {
    shotLocks.delete(k);
    patchShot(vid, sid, { busy: false });
  }
}
const isShotBusy = (vid, sid) => shotLocks.has(key(vid, sid));

// Elle yüklenen klip: hareketli/flow çekimde ham klip (ses işlenir), diğerlerinde doğrudan video
async function acceptUploadedClip(vid, sid, buffer) {
  const { shot } = ctx(vid, sid);
  const n = fileNames(sid);
  if (shot.tool === 'gemini' || shot.tool === 'flow') {
    const raw = store.videoFile(vid, n.raw);
    fs.writeFileSync(raw, buffer);
    patchShot(vid, sid, { raw: n.raw, rawAt: Date.now(), rawDuration: await media.duration(raw), video: null, manual: true, error: null, fixNote: '' });
    runShot(vid, sid, 'fixvoice');
  } else {
    const video = store.videoFile(vid, n.video);
    fs.writeFileSync(video, buffer);
    patchShot(vid, sid, { video: n.video, videoAt: Date.now(), actualDuration: await media.duration(video), manual: true, error: null, status: 'Hazır (elle yüklendi)' });
  }
}

// Elle yüklenen ilk kare görseli: video çıktıları sıfırlanır, görsel korunur.
async function acceptUploadedImage(vid, sid, buffer) {
  const n = fileNames(sid);
  fs.writeFileSync(store.videoFile(vid, n.image), buffer);
  patchShot(vid, sid, { image: n.image, imageAt: Date.now(), imageManual: true, raw: null, video: null, manual: false, error: null, fixNote: '', status: 'Bekliyor' });
}

// --- Ses katmanları (müzik / efekt) ----------------------------------------------------------
function libraryAudioMatch(lib, source) {
  const tag = String(source || '').replace(/^library:/i, '').trim().toLowerCase();
  if (!tag) return null;
  const items = lib.audio || [];
  return items.find((a) => (a.tags || '').toLowerCase().includes(tag) || a.name.toLowerCase().includes(tag))
    || items.find((a) => tag.split(/[\s,]+/).some((w) => w.length > 2 && ((a.tags || '').toLowerCase().includes(w) || a.name.toLowerCase().includes(w))));
}

async function generateAudioLayers(vid) {
  const { lib, video } = ctx(vid, null);
  for (let i = 0; i < (video.audio || []).length; i++) {
    const a = store.getVideo(vid).audio[i];
    if (a.type === 'silence' || a.file) continue;
    const len = Math.max(1, (a.end || 0) - (a.start || 0));
    try {
      if ((a.source || '').startsWith('library:')) {
        const match = libraryAudioMatch(lib, a.source);
        if (match) { store.updateVideo(vid, (v) => { v.audio[i].file = 'lib:' + match.file; v.audio[i].error = null; v.audio[i].note = ''; v.audio[i].status = 'Hazır'; }); continue; }
        store.updateVideo(vid, (v) => { v.audio[i].note = 'Kütüphanede eşleşen dosya yok, üretildi.'; });
      }
      store.updateVideo(vid, (v) => { v.audio[i].status = 'Üretiliyor'; });
      const name = `audio-${i}-${a.type}.mp3`;
      if (a.type === 'music') {
        await eleven.music(a.description, Math.min(300, len), store.videoFile(vid, name), true);
        costs.record(vid, null, { servis: 'elevenlabs', model: eleven.MUSIC_MODEL, miktar: Math.round(len), birim: 'saniye', not: 'Müzik', ...costs.musicCost(len) });
      } else {
        const secs = Math.min(30, len);
        await eleven.soundEffect(a.description, secs, store.videoFile(vid, name));
        costs.record(vid, null, { servis: 'elevenlabs', model: eleven.SFX_MODEL, miktar: Math.round(secs * 10) / 10, birim: 'saniye', not: 'Efekt', ...costs.sfxCost(secs) });
      }
      store.updateVideo(vid, (v) => { v.audio[i].file = name; v.audio[i].status = 'Hazır'; v.audio[i].error = null; });
    } catch (err) {
      store.updateVideo(vid, (v) => { v.audio[i].status = 'Hata'; v.audio[i].error = err.message || String(err); });
    }
  }
}

// --- Üretim ------------------------------------------------------------------------------------
function produce(vid) {
  const lk = vid + ':produce';
  if (videoLocks.has(lk)) throw new Error('Üretim zaten çalışıyor.');
  const video = store.getVideo(vid);
  if (!video || !video.shots.length) throw new Error('Üretilecek çekim yok.');
  videoLocks.add(lk);
  store.updateVideo(vid, (v) => { v.producing = true; v.approved = true; v.finalError = null; });
  (async () => {
    try {
      for (const sid of video.shots.map((s) => s.id)) {
        const cur = store.getVideo(vid);
        if (!cur) break;
        const s = cur.shots.find((x) => x.id === sid);
        if (!s || isShotBusy(vid, sid)) continue;
        const done = exists(vid, s.video) && (!s.voiceover.length || (s.voFiles && s.voFiles.length));
        if (done) continue;
        if (s.tool === 'flow' && !exists(vid, s.raw)) {
          if (!exists(vid, s.image) || (s.voiceover.length && !(s.voFiles && s.voFiles.length))) await runShot(vid, sid, 'auto');
          const after = store.getVideo(vid).shots.find((x) => x.id === sid);
          if (after && after.image && !after.error) patchShot(vid, sid, { status: 'Klip bekleniyor (dış araç)' });
          continue;
        }
        await runShot(vid, sid, 'auto');
      }
      await generateAudioLayers(vid);
    } finally {
      videoLocks.delete(lk);
      store.updateVideo(vid, (v) => { v.producing = false; });
    }
    const cur = store.getVideo(vid);
    if (cur && cur.shots.every((s) => exists(vid, s.video))) { try { assembleFinal(vid); } catch { /* zaten çalışıyor */ } }
  })();
}

// --- Birleştirme -------------------------------------------------------------------------------
function assembleFinal(vid) {
  const lk = vid + ':assemble';
  if (videoLocks.has(lk)) throw new Error('Birleştirme zaten çalışıyor.');
  const video = store.getVideo(vid);
  if (!video || !video.shots.length) throw new Error('Birleştirilecek çekim yok.');
  const missing = video.shots.filter((s) => !exists(vid, s.video)).map((s) => s.id);
  if (missing.length) throw new Error('Videosu olmayan çekimler var: ' + missing.join(', '));
  videoLocks.add(lk);
  store.updateVideo(vid, (v) => { v.assembling = true; v.approved = true; v.finalError = null; v.finalStatus = 'Birleştirme başladı'; });
  (async () => {
    try {
      const lib = store.getLibrary();
      const sections = new Map((video.plan.sections || []).map((s) => [s.id, s]));
      // gerçek süreler ve zaman eşlemesi (planlanan → gerçek)
      const shots = [];
      let t = 0;
      for (let i = 0; i < video.shots.length; i++) {
        const s = video.shots[i];
        const file = store.videoFile(vid, s.video);
        const dur = s.actualDuration || (await media.duration(file)) || s.duration;
        const next = video.shots[i + 1];
        const sec = sections.get(s.section_id) || {};
        shots.push({
          id: s.id, file, duration: dur, planStart: s.start, planDur: s.duration || dur, actualStart: t,
          hasAudio: await media.hasAudio(file),
          grade: sec.color_grade || 'none',
          overlays: s.tool === 'text_card' ? [] : (s.onscreen_text || []),
          sectionEnd: !!next && next.section_id !== s.section_id,
          voFiles: s.voFiles || [],
        });
        t += dur;
      }
      const total = t;
      const mapTime = (pt) => {
        for (const sh of shots) {
          if (pt >= sh.planStart && pt < sh.planStart + sh.planDur) return sh.actualStart + ((pt - sh.planStart) / sh.planDur) * sh.duration;
        }
        return pt <= 0 ? 0 : total;
      };
      const voiceovers = [];
      for (const sh of shots) {
        let at = sh.actualStart;
        for (const vo of sh.voFiles) { voiceovers.push({ file: store.videoFile(vid, vo.file), at }); at += (vo.duration || 0) + 0.35; }
      }
      const music = [], silences = [];
      for (const a of video.audio || []) {
        const start = mapTime(a.start), end = Math.max(start + 0.5, mapTime(a.end));
        if (a.type === 'silence') { silences.push({ start, end }); continue; }
        if (!a.file) continue;
        const file = a.file.startsWith('lib:') ? store.libFile(a.file.slice(4)) : store.videoFile(vid, a.file);
        if (fs.existsSync(file)) music.push({ file, start, end, kind: a.type === 'sfx' ? 'sfx' : 'music' });
      }
      store.updateVideo(vid, (v) => { v.finalStatus = `Çekimler birleştiriliyor (${shots.length} çekim, ${Math.round(total)} sn)`; });
      const outFile = store.videoFile(vid, 'final.mp4');
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
      await media.assemble({ aspect: video.plan.aspect, dir: store.videoDir(vid), outFile, shots, voiceovers, music, silences, lookGrade: look.gradeFilter(look.forVideo(store.getSettings(), video)) });
      const dur = await media.duration(outFile);
      store.updateVideo(vid, (v) => { v.final = 'final.mp4'; v.finalAt = Date.now(); v.finalDuration = dur; v.finalStatus = 'Final video hazır'; });
      void lib;
    } catch (err) {
      store.updateVideo(vid, (v) => { v.finalStatus = 'Hata'; v.finalError = err.message || String(err); });
    } finally {
      videoLocks.delete(lk);
      store.updateVideo(vid, (v) => { v.assembling = false; });
    }
  })();
}

function resetStaleFlags() {
  for (const v of store.listVideos()) {
    let changed = false;
    if (v.planning) { v.planning = false; v.planError = v.planError || 'Sunucu yeniden başlatıldı, planı tekrar isteyin.'; changed = true; }
    if (v.producing) { v.producing = false; changed = true; }
    if (v.assembling) { v.assembling = false; v.finalStatus = 'Sunucu yeniden başlatıldı'; changed = true; }
    for (const s of v.shots || []) if (s.busy) { s.busy = false; s.status = computeStatus(v.id, s); s.error = 'Sunucu yeniden başlatıldığı için iş yarım kaldı. Tekrar üretin.'; changed = true; }
    for (const a of v.audio || []) if (a.status === 'Üretiliyor') { a.status = 'Hata'; a.error = 'Sunucu yeniden başlatıldı.'; changed = true; }
    if (changed) store.saveVideo(v);
  }
}

function videoStatus(v) {
  const has = (n) => exists(v.id, n);
  if (v.planning) return 'Planlanıyor';
  if (v.planError && !v.shots.length) return 'Plan hatası';
  if (!v.shots.length) return 'Plan yok';
  if (v.final && has(v.final)) return 'Hazır';
  if (v.producing || v.assembling || v.shots.some((s) => s.busy)) return 'Üretiliyor';
  if (!v.approved) return 'Onay bekliyor';
  if (v.shots.some((s) => s.tool === 'flow' && !has(s.raw) && !has(s.video))) return 'Klip bekleniyor (dış araç)';
  if (v.shots.some((s) => s.error)) return 'Hata var';
  const done = v.shots.filter((s) => has(s.video)).length;
  if (done === v.shots.length) return 'Birleştirmeye hazır';
  return done + '/' + v.shots.length + ' çekim hazır';
}

module.exports = { runShot, produce, assembleFinal, generateAudioLayers, acceptUploadedClip, acceptUploadedImage, computeStatus, fileNames, resetStaleFlags, isShotBusy, videoStatus };
