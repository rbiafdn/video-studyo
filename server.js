// Video Stüdyo – otomatik yönetmen sunucusu
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');

const store = require('./lib/store');
const claude = require('./lib/claude');
const gemini = require('./lib/gemini');
const eleven = require('./lib/elevenlabs');
const fal = require('./lib/fal');
const media = require('./lib/media');
const jobs = require('./lib/jobs');
const costs = require('./lib/costs');

const PORT = Number(process.env.PORT) || 3000;
const app = express();
const NAME_RE = /^[\w.-]+$/;
const TOOLS = ['avatar', 'gemini', 'flow', 'seedance', 'text_card'];
const BILLING_LINKS = {
  anthropic: 'https://platform.claude.com/settings/billing',
  gemini: 'https://console.cloud.google.com/billing',
  fal: 'https://fal.ai/dashboard/billing',
  elevenlabs: 'https://elevenlabs.io/app/subscription',
};

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const rawBody = (limit) => express.raw({ type: () => true, limit });
const sendError = (res, err, code) => res.status(code || 400).json({ error: err && err.message ? err.message : String(err) });

// --- Dosyalar ------------------------------------------------------------------------------
app.get('/files/lib/:name', (req, res) => {
  if (!NAME_RE.test(req.params.name)) return res.status(400).end();
  const file = store.libFile(req.params.name);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});
app.get('/files/v/:id/:name', (req, res) => {
  const { id, name } = req.params;
  if (!store.ID_RE.test(id) || !NAME_RE.test(name)) return res.status(400).end();
  const file = store.videoFile(id, name);
  if (!fs.existsSync(file)) return res.status(404).end();
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.sendFile(file);
});

function budgetGate(req, res, video, extraUsd) {
  if (req.body && req.body.confirmed === true) return false;
  const warn = costs.budgetWarning(video, extraUsd);
  if (!warn) return false;
  res.status(409).json({ needsConfirm: true, message: warn });
  return true;
}

// --- Genel ----------------------------------------------------------------------------------
app.get('/api/status', (req, res) => {
  res.json({
    keys: { anthropic: claude.isConfigured(), gemini: gemini.isConfigured(), elevenlabs: eleven.isConfigured(), fal: fal.isConfigured() },
    models: { claude: claude.MODEL, claudeHard: claude.MODEL_HARD, image: gemini.IMAGE_MODEL, video: gemini.VIDEO_MODEL, tts: eleven.TTS_MODEL, dialogue: eleven.DIALOGUE_MODEL, sts: eleven.STS_MODEL, music: eleven.MUSIC_MODEL, sfx: eleven.SFX_MODEL, avatar: fal.AVATAR_MODEL, avatarFallback: fal.FALLBACK_MODEL, seedance: fal.SEEDANCE_MODEL },
    ffmpeg: !!media.ffmpegPath,
  });
});
app.get('/api/prices', (req, res) => { try { res.json({ prices: costs.prices(), models: costs.activeModels() }); } catch (err) { sendError(res, err, 500); } });
app.get('/api/balances', async (req, res) => {
  const out = { links: BILLING_LINKS, elevenlabs: null, elevenlabsError: null };
  if (eleven.isConfigured()) { try { out.elevenlabs = await eleven.subscription(); } catch (err) { out.elevenlabsError = err.message; } }
  res.json(out);
});
app.get('/api/voices', async (req, res) => { try { res.json(await eleven.listVoices(req.query.refresh === '1')); } catch (err) { sendError(res, err); } });

app.get('/api/settings', (req, res) => res.json(store.getSettings()));
app.patch('/api/settings', (req, res) => {
  const b = req.body || {};
  res.json(store.updateSettings((st) => {
    if (typeof b.notes === 'string') st.notes = b.notes.trim();
    if (['16:9', '9:16', '1:1', 'auto'].includes(b.aspect)) st.aspect = b.aspect;
    if (b.defaultBudget != null && Number(b.defaultBudget) >= 0) st.defaultBudget = Number(b.defaultBudget);
    if (b.movingProvider === 'gemini' || b.movingProvider === 'flow') st.movingProvider = b.movingProvider;
  }));
});

// --- Kütüphane ------------------------------------------------------------------------------------
const KINDS = ['characters', 'locations', 'narrators', 'audio'];
const kindOk = (k) => KINDS.includes(k);

app.get('/api/library', (req, res) => res.json(store.getLibrary()));

app.post('/api/library/:kind', (req, res, next) => {
  const { kind } = req.params;
  if (kind === 'audio') return next(); // ses dosyası yükleme rotası aşağıda
  if (!kindOk(kind)) return sendError(res, new Error('Geçersiz tür'));
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return sendError(res, new Error('Ad boş olamaz.'));
  try {
    let created;
    store.updateLibrary((lib) => {
      if (lib[kind].some((x) => x.name === b.name.trim())) throw new Error('Bu adda bir kayıt zaten var.');
      created = { id: store.shortId(), name: b.name.trim() };
      if (kind === 'characters') Object.assign(created, { description: String(b.description || '').trim(), voiceId: String(b.voiceId || '').trim(), voiceNote: String(b.voiceNote || '').trim(), photos: [] });
      if (kind === 'locations') Object.assign(created, { description: String(b.description || '').trim(), photos: [] });
      if (kind === 'narrators') Object.assign(created, { voiceId: String(b.voiceId || '').trim() });
      lib[kind].push(created);
    });
    res.json(created);
  } catch (err) { sendError(res, err); }
});

app.patch('/api/library/:kind/:id', (req, res) => {
  const { kind, id } = req.params;
  if (!kindOk(kind)) return sendError(res, new Error('Geçersiz tür'));
  try {
    let out;
    store.updateLibrary((lib) => {
      const it = lib[kind].find((x) => x.id === id);
      if (!it) throw new Error('Kayıt bulunamadı');
      const b = req.body || {};
      if (typeof b.name === 'string' && b.name.trim()) it.name = b.name.trim();
      for (const f of ['description', 'voiceId', 'voiceNote', 'tags']) if (typeof b[f] === 'string' && f in it) it[f] = b[f].trim();
      if (kind === 'audio' && typeof b.tags === 'string') it.tags = b.tags.trim();
      out = it;
    });
    res.json(out);
  } catch (err) { sendError(res, err); }
});

app.delete('/api/library/:kind/:id', (req, res) => {
  const { kind, id } = req.params;
  if (!kindOk(kind)) return sendError(res, new Error('Geçersiz tür'));
  try {
    store.updateLibrary((lib) => {
      const it = lib[kind].find((x) => x.id === id);
      if (!it) throw new Error('Kayıt bulunamadı');
      for (const f of [...(it.photos || []), it.file].filter(Boolean)) { try { fs.unlinkSync(store.libFile(f)); } catch { /* yok */ } }
      lib[kind] = lib[kind].filter((x) => x.id !== id);
    });
    res.json({ ok: true });
  } catch (err) { sendError(res, err); }
});

// Referans fotoğraf (karakter/mekân, en fazla 4)
app.post('/api/library/:kind/:id/photo', rawBody('30mb'), (req, res) => {
  const { kind, id } = req.params;
  if (kind !== 'characters' && kind !== 'locations') return sendError(res, new Error('Geçersiz tür'));
  try {
    if (!req.body || !req.body.length) throw new Error('Dosya boş.');
    const ct = String(req.headers['content-type'] || '');
    const ext = /png/.test(ct) ? 'png' : /webp/.test(ct) ? 'webp' : 'jpg';
    let out;
    store.updateLibrary((lib) => {
      const it = lib[kind].find((x) => x.id === id);
      if (!it) throw new Error('Kayıt bulunamadı');
      if ((it.photos || []).length >= 4) throw new Error('En fazla 4 referans fotoğraf.');
      const name = `${kind}-${it.id}-${Date.now()}.${ext}`;
      fs.writeFileSync(store.libFile(name), req.body);
      (it.photos = it.photos || []).push(name);
      out = it;
    });
    res.json(out);
  } catch (err) { sendError(res, err); }
});
app.delete('/api/library/:kind/:id/photo/:name', (req, res) => {
  const { kind, id, name } = req.params;
  if ((kind !== 'characters' && kind !== 'locations') || !NAME_RE.test(name)) return sendError(res, new Error('Geçersiz istek'));
  try {
    let out;
    store.updateLibrary((lib) => {
      const it = lib[kind].find((x) => x.id === id);
      if (!it) throw new Error('Kayıt bulunamadı');
      it.photos = (it.photos || []).filter((p) => p !== name);
      try { fs.unlinkSync(store.libFile(name)); } catch { /* yok */ }
      out = it;
    });
    res.json(out);
  } catch (err) { sendError(res, err); }
});

// Müzik / efekt dosyası (ham gövde; ?name=&tags=)
app.post('/api/library/audio', rawBody('100mb'), async (req, res) => {
  try {
    if (!req.body || !req.body.length) throw new Error('Dosya boş.');
    const name = String(req.query.name || 'ses').trim().slice(0, 80) || 'ses';
    const tags = String(req.query.tags || '').trim().slice(0, 200);
    const ct = String(req.headers['content-type'] || '');
    const ext = /wav/.test(ct) ? 'wav' : /ogg/.test(ct) ? 'ogg' : /m4a|mp4|aac/.test(ct) ? 'm4a' : 'mp3';
    const file = `audio-${store.shortId()}.${ext}`;
    fs.writeFileSync(store.libFile(file), req.body);
    const duration = await media.duration(store.libFile(file));
    let created;
    store.updateLibrary((lib) => { created = { id: store.shortId(), name, tags, file, duration }; lib.audio.push(created); });
    res.json(created);
  } catch (err) { sendError(res, err); }
});

// --- Videolar ----------------------------------------------------------------------------------------
function selectedAssets(video) {
  const lib = store.getLibrary();
  const auto = !video.assets || video.assets.auto !== false;
  const pickIds = (arr, ids) => (auto ? arr : arr.filter((x) => (ids || []).includes(x.id)));
  return {
    characters: pickIds(lib.characters, video.assets && video.assets.characters),
    locations: pickIds(lib.locations, video.assets && video.assets.locations),
    narrators: pickIds(lib.narrators, video.assets && video.assets.narrators),
    audio: lib.audio,
  };
}
function summary(v) {
  return {
    id: v.id, name: v.name || v.script.slice(0, 50), createdAt: v.createdAt, updatedAt: v.updatedAt,
    aspect: v.plan ? v.plan.aspect : v.aspect, status: jobs.videoStatus(v), shotCount: v.shots.length, budget: v.budget,
    targetSeconds: v.plan ? v.plan.target_duration : v.targetSeconds, toplam_usd: costs.summarize(v).toplam_usd, hasFinal: !!v.final, approved: !!v.approved,
    warnings: v.plan ? (v.plan.warnings || []).length : 0,
  };
}
function decorateVideo(v) {
  const settings = store.getSettings();
  const d = costs.decorate(settings, selectedAssets(v), v);
  const lib = store.getLibrary();
  d.library = { characters: lib.characters.map((c) => ({ id: c.id, name: c.name, voiceId: c.voiceId, photos: c.photos || [] })), locations: lib.locations.map((l) => ({ id: l.id, name: l.name, photos: l.photos || [] })), narrators: lib.narrators, audio: lib.audio.map((a) => ({ id: a.id, name: a.name, tags: a.tags })) };
  return d;
}

function startPlanning(video) {
  store.updateVideo(video.id, (v) => { v.planning = true; v.planError = null; });
  (async () => {
    try {
      const settings = store.getSettings();
      const assets = selectedAssets(video);
      const { plan, usage } = await claude.planVideo(settings, assets, video);
      costs.record(video.id, null, { servis: 'claude', model: usage.model, birim: 'token', miktar: usage.input_tokens + usage.output_tokens, girdi_token: usage.input_tokens, cikti_token: usage.output_tokens, ...costs.claudeCost(usage.model, usage), not: 'Çekim listesi' });
      if (plan.new_characters.length) {
        store.updateLibrary((lib) => {
          for (const nc of plan.new_characters) {
            if (!nc.name || lib.characters.some((c) => c.name === nc.name)) continue;
            lib.characters.push({ id: store.shortId(), name: nc.name, description: nc.description || '', voiceId: '', voiceNote: '', photos: [] });
          }
        });
      }
      store.updateVideo(video.id, (v) => {
        v.plan = { title: plan.title, aspect: plan.aspect, target_duration: plan.target_duration, sections: plan.sections, warnings: plan.warnings, questions: plan.questions, model: usage.model };
        if (plan.title && !v.name) v.name = plan.title;
        v.shots = plan.shots.map((s) => ({
          ...s,
          tool: s.tool === 'motion' ? v.movingProvider : s.tool,
          suggested_tool: s.tool,
          motion_prompt: '', fixVoice: true,
          image: null, audio: null, raw: null, video: null, voFiles: [], manual: false,
          status: 'Bekliyor', error: null, busy: false, fixNote: '', costs: [],
        }));
        v.audio = plan.audio.map((a) => ({ ...a, file: null, status: '', error: null }));
        v.approved = false; v.final = null; v.finalStatus = ''; v.finalError = null; v.planning = false;
      });
    } catch (err) {
      store.updateVideo(video.id, (v) => { v.planning = false; v.planError = err.message || String(err); });
    }
  })();
}

app.get('/api/videos', (req, res) => res.json(store.listVideos().map(summary)));
app.post('/api/videos', (req, res) => {
  const b = req.body || {};
  if (!b.script || !String(b.script).trim()) return sendError(res, new Error('Senaryo boş olamaz.'));
  if (!claude.isConfigured()) return sendError(res, new Error('ANTHROPIC_API_KEY tanımlı değil.'));
  const v = store.createVideo(b);
  startPlanning(v);
  res.json(v);
});
function getV(req, res) { const v = store.getVideo(req.params.id); if (!v) { sendError(res, new Error('Video bulunamadı'), 404); return null; } return v; }

app.get('/api/videos/:id', (req, res) => { const v = getV(req, res); if (v) res.json(decorateVideo(v)); });
app.delete('/api/videos/:id', (req, res) => { try { store.deleteVideo(req.params.id); res.json({ ok: true }); } catch (err) { sendError(res, err); } });
app.patch('/api/videos/:id', (req, res) => {
  try {
    const v = store.updateVideo(req.params.id, (vv) => {
      const b = req.body || {};
      if (typeof b.name === 'string' && b.name.trim()) vv.name = b.name.trim();
      if (b.budget != null && Number(b.budget) >= 0) vv.budget = Number(b.budget);
      if (b.movingProvider === 'gemini' || b.movingProvider === 'flow') vv.movingProvider = b.movingProvider;
      if (b.approved === false) vv.approved = false;
    });
    res.json(decorateVideo(v));
  } catch (err) { sendError(res, err); }
});

app.post('/api/videos/:id/plan', (req, res) => {
  let v = getV(req, res);
  if (!v) return;
  if (!claude.isConfigured()) return sendError(res, new Error('ANTHROPIC_API_KEY tanımlı değil.'));
  if (v.planning) return sendError(res, new Error('Plan zaten hazırlanıyor.'));
  const b = req.body || {};
  v = store.updateVideo(v.id, (vv) => {
    if (typeof b.script === 'string' && b.script.trim()) vv.script = b.script.trim();
    if (b.targetSeconds != null) vv.targetSeconds = Math.max(0, Number(b.targetSeconds) || 0);
    if (typeof b.hardPlanning === 'boolean') vv.hardPlanning = b.hardPlanning;
    if (b.budget != null && Number(b.budget) >= 0) vv.budget = Number(b.budget);
    if (b.assets) vv.assets = { auto: b.assets.auto !== false, characters: b.assets.characters || [], locations: b.assets.locations || [], narrators: b.assets.narrators || [] };
  });
  if (budgetGate(req, res, v, costs.estimatePlan(store.getSettings(), selectedAssets(v), v).usd)) return;
  startPlanning(v);
  res.json({ ok: true });
});

// Çekim başlangıç zamanlarını yeniden hesapla
function relayout(v) {
  let t = 0;
  for (const s of v.shots) { s.start = Math.round(t * 10) / 10; t += Number(s.duration) || 0; }
  if (v.plan) v.plan.target_duration = Math.round(t);
}

app.patch('/api/videos/:id/shots/:sid', (req, res) => {
  const sid = Number(req.params.sid);
  try {
    const v = store.updateVideo(req.params.id, (vv) => {
      const s = vv.shots.find((x) => x.id === sid);
      if (!s) throw new Error('Çekim bulunamadı');
      const b = req.body || {};
      for (const f of ['description', 'camera', 'location', 'tool_reason', 'image_prompt', 'video_prompt', 'motion_prompt']) if (typeof b[f] === 'string') s[f] = b[f];
      for (const f of ['characters', 'dialogue', 'voiceover', 'onscreen_text']) if (Array.isArray(b[f])) s[f] = b[f];
      if (typeof b.fixVoice === 'boolean') s.fixVoice = b.fixVoice;
      if (b.duration != null && Number(b.duration) > 0) s.duration = Math.round(Number(b.duration) * 10) / 10;
      if (b.section_id != null) s.section_id = Number(b.section_id);
      if (b.tool && TOOLS.includes(b.tool) && b.tool !== s.tool) {
        s.tool = b.tool;
        Object.assign(s, { video: null, raw: null, audio: null, manual: false, status: 'Bekliyor', error: null, fixNote: '' });
      }
      if (Array.isArray(b.dialogue) || Array.isArray(b.voiceover)) { s.audio = null; s.voFiles = []; if (s.video && s.tool === 'avatar') { s.video = null; s.status = 'Bekliyor'; } }
      relayout(vv);
    });
    res.json(decorateVideo(v));
  } catch (err) { sendError(res, err); }
});

app.delete('/api/videos/:id/shots/:sid', (req, res) => {
  const sid = Number(req.params.sid);
  try {
    const v = store.updateVideo(req.params.id, (vv) => {
      if (!vv.shots.some((x) => x.id === sid)) throw new Error('Çekim bulunamadı');
      vv.shots = vv.shots.filter((x) => x.id !== sid);
      relayout(vv);
    });
    res.json(decorateVideo(v));
  } catch (err) { sendError(res, err); }
});

// Yeni çekim ekle (after: hangi çekimden sonra; 0 = başa)
app.post('/api/videos/:id/shots', (req, res) => {
  try {
    const b = req.body || {};
    const v = store.updateVideo(req.params.id, (vv) => {
      const idx = b.after ? vv.shots.findIndex((x) => x.id === Number(b.after)) + 1 : 0;
      const ref = vv.shots[Math.max(0, idx - 1)] || {};
      const id = vv.shots.reduce((m, s) => Math.max(m, s.id), 0) + 1;
      const shot = {
        id, section_id: Number(b.section_id) || ref.section_id || 1, start: 0, duration: Number(b.duration) > 0 ? Number(b.duration) : 5,
        description: String(b.description || 'Yeni çekim'), camera: String(b.camera || ''), characters: Array.isArray(b.characters) ? b.characters : [], location: String(b.location || ref.location || ''),
        dialogue: [], voiceover: [], onscreen_text: [], tool: TOOLS.includes(b.tool) ? b.tool : 'seedance', suggested_tool: '', tool_reason: 'Elle eklendi',
        image_prompt: String(b.image_prompt || ''), video_prompt: String(b.video_prompt || ''), motion_prompt: '', fixVoice: true,
        image: null, audio: null, raw: null, video: null, voFiles: [], manual: false, status: 'Bekliyor', error: null, busy: false, fixNote: '', costs: [],
      };
      if (shot.tool === 'text_card') shot.onscreen_text = [{ text: shot.description, style: 'hook', start: 0, duration: shot.duration }];
      vv.shots.splice(idx, 0, shot);
      relayout(vv);
    });
    res.json(decorateVideo(v));
  } catch (err) { sendError(res, err); }
});

// Ses katmanları (tam liste)
app.patch('/api/videos/:id/audio', (req, res) => {
  try {
    const list = Array.isArray(req.body && req.body.audio) ? req.body.audio : null;
    if (!list) throw new Error('audio listesi gerekli');
    const v = store.updateVideo(req.params.id, (vv) => {
      const old = vv.audio || [];
      vv.audio = list.map((a, i) => ({
        type: ['music', 'sfx', 'silence'].includes(a.type) ? a.type : 'music', description: String(a.description || ''),
        start: Math.max(0, Number(a.start) || 0), end: Math.max(0, Number(a.end) || 0), source: String(a.source || 'generate'),
        file: old[i] && old[i].description === a.description && old[i].source === a.source ? old[i].file : null, status: '', error: null,
      }));
    });
    res.json(decorateVideo(v));
  } catch (err) { sendError(res, err); }
});

app.post('/api/videos/:id/shots/:sid/generate', (req, res) => {
  const v = getV(req, res);
  if (!v) return;
  const sid = Number(req.params.sid);
  const s = v.shots.find((x) => x.id === sid);
  if (!s) return sendError(res, new Error('Çekim bulunamadı'), 404);
  if (jobs.isShotBusy(v.id, sid) || s.busy) return sendError(res, new Error('Bu çekimde zaten bir iş çalışıyor.'));
  const step = (req.body && req.body.step) || 'auto';
  if (!['auto', 'all', 'image', 'audio', 'voiceover', 'video', 'fixvoice'].includes(step)) return sendError(res, new Error('Geçersiz adım'));
  if (budgetGate(req, res, v, costs.estimateStep(v, s, step).usd)) return;
  store.updateVideo(v.id, (vv) => { vv.approved = true; });
  jobs.runShot(v.id, sid, step);
  res.json({ ok: true });
});

// Türkçe düzeltme notuyla çekimi yeniden yazdır (Claude); çıktılar sıfırlanır, üretim ayrıca tetiklenir.
app.post('/api/videos/:id/shots/:sid/revise', async (req, res) => {
  const v = getV(req, res);
  if (!v) return;
  const sid = Number(req.params.sid);
  const s = v.shots.find((x) => x.id === sid);
  if (!s) return sendError(res, new Error('Çekim bulunamadı'), 404);
  if (jobs.isShotBusy(v.id, sid) || s.busy) return sendError(res, new Error('Bu çekimde zaten bir iş çalışıyor.'));
  const note = String((req.body && req.body.note) || '').trim();
  if (!note) return sendError(res, new Error('Düzeltme notu boş.'));
  if (!claude.isConfigured()) return sendError(res, new Error('ANTHROPIC_API_KEY tanımlı değil.'));
  try {
    const assets = selectedAssets(v);
    const notes = (s.revisions || []).map((r) => r.note);
    const { patch, usage } = await claude.reviseShot({ shot: s, aspect: v.plan ? v.plan.aspect : v.aspect, assets, notes, note });
    const out = store.updateVideo(v.id, (vv) => {
      const sh = vv.shots.find((x) => x.id === sid);
      for (const f of ['description', 'camera', 'image_prompt', 'video_prompt']) if (typeof patch[f] === 'string' && patch[f].trim()) sh[f] = patch[f];
      if (Array.isArray(patch.dialogue) && patch.dialogue.length) sh.dialogue = patch.dialogue.map((d) => ({ speaker: String(d.speaker || ''), line: String(d.line || ''), emotion: String(d.emotion || '') }));
      if (Number(patch.duration) > 0) sh.duration = Math.round(Number(patch.duration) * 10) / 10;
      if (sh.tool === 'gemini' || sh.tool === 'flow') sh.duration = Math.min(8, Math.max(sh.duration, Math.ceil(claude.speechSeconds(sh.dialogue) * 2) / 2));
      sh.revisions = (sh.revisions || []).concat([{ note, answer: String(patch.answer_tr || ''), at: new Date().toISOString() }]);
      Object.assign(sh, { image: null, raw: null, video: null, audio: null, manual: false, status: 'Bekliyor', error: null, fixNote: '', video_prompt_soft: null, video_prompt_soft_for: null, actualDuration: null, rawDuration: null });
      relayout(vv);
    });
    costs.record(v.id, sid, { servis: 'claude', model: usage.model, birim: 'token', miktar: usage.input_tokens + usage.output_tokens, girdi_token: usage.input_tokens, cikti_token: usage.output_tokens, ...costs.claudeCost(usage.model, usage), not: 'Düzeltme notu' });
    res.json({ ok: true, answer: String(patch.answer_tr || ''), video: decorateVideo(store.getVideo(v.id) || out) });
  } catch (err) { sendError(res, err); }
});

app.post('/api/videos/:id/shots/:sid/upload', rawBody('2gb'), async (req, res) => {
  const v = getV(req, res);
  if (!v) return;
  const sid = Number(req.params.sid);
  if (!v.shots.some((x) => x.id === sid)) return sendError(res, new Error('Çekim bulunamadı'), 404);
  if (!req.body || !req.body.length) return sendError(res, new Error('Dosya boş.'));
  if (jobs.isShotBusy(v.id, sid)) return sendError(res, new Error('Bu çekimde zaten bir iş çalışıyor.'));
  try { await jobs.acceptUploadedClip(v.id, sid, req.body); res.json({ ok: true }); } catch (err) { sendError(res, err); }
});

// Onayla ve üret
app.post('/api/videos/:id/produce', (req, res) => {
  const v = getV(req, res);
  if (!v) return;
  try {
    if (budgetGate(req, res, v, costs.estimateAll(v).usd)) return;
    jobs.produce(v.id);
    res.json({ ok: true });
  } catch (err) { sendError(res, err); }
});
app.post('/api/videos/:id/audio/generate', (req, res) => {
  const v = getV(req, res);
  if (!v) return;
  const items = costs.estimateAudioLayers(v);
  if (budgetGate(req, res, v, items.reduce((n, i) => n + (i.usd || 0), 0))) return;
  jobs.generateAudioLayers(v.id);
  res.json({ ok: true });
});
app.post('/api/videos/:id/assemble', (req, res) => {
  const v = getV(req, res);
  if (!v) return;
  try { jobs.assembleFinal(v.id); res.json({ ok: true }); } catch (err) { sendError(res, err); }
});

app.use((err, req, res, next) => { if (res.headersSent) return next(err); sendError(res, err, err.status || 500); });

jobs.resetStaleFlags();
app.listen(PORT, () => {
  console.log(`Video Stüdyo çalışıyor: http://localhost:${PORT}`);
  const k = { ANTHROPIC_API_KEY: claude.isConfigured(), GEMINI_API_KEY: gemini.isConfigured(), ELEVENLABS_API_KEY: eleven.isConfigured(), FAL_KEY: fal.isConfigured() };
  for (const [name, ok] of Object.entries(k)) console.log(`  ${ok ? '✓' : '·'} ${name}${ok ? '' : ' (tanımlı değil)'}`);
  if (!media.ffmpegPath) console.log('  ! ffmpeg-static bulunamadı');
});
