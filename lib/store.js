// Veri katmanı: data/settings.json, data/library/ (varlık kütüphanesi: JSON + dosyalar),
// data/videos/<id>/video.json (+ medya dosyaları)
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const LIB_DIR = path.join(DATA_DIR, 'library');
const LIB_FILES = path.join(LIB_DIR, 'files');
const LIB_JSON = path.join(LIB_DIR, 'library.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ID_RE = /^[\w-]+$/;

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const newId = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6);
const shortId = () => Math.random().toString(36).slice(2, 10);

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// --- Ayarlar ------------------------------------------------------------------------
const DEFAULT_SETTINGS = { aspect: 'auto', defaultBudget: 20, movingProvider: 'gemini', notes: '' };
function getSettings() { return Object.assign({}, DEFAULT_SETTINGS, readJson(SETTINGS_FILE) || {}); }
function saveSettings(s) { writeJson(SETTINGS_FILE, s); return s; }
function updateSettings(mutator) { const s = getSettings(); mutator(s); return saveSettings(s); }

// --- Kütüphane -----------------------------------------------------------------------
// characters: [{id, name, description, voiceId, voiceNote, photos: []}]
// locations:  [{id, name, description, photos: []}]
// narrators:  [{id, name, voiceId}]
// audio:      [{id, name, tags, file, duration}]
const EMPTY_LIB = { characters: [], locations: [], narrators: [], audio: [] };
function getLibrary() {
  const l = Object.assign({}, EMPTY_LIB, readJson(LIB_JSON) || {});
  for (const k of Object.keys(EMPTY_LIB)) if (!Array.isArray(l[k])) l[k] = [];
  return l;
}
function saveLibrary(l) { writeJson(LIB_JSON, l); return l; }
function updateLibrary(mutator) { const l = getLibrary(); mutator(l); return saveLibrary(l); }
function libFile(name) { ensureDir(LIB_FILES); return path.join(LIB_FILES, name); }

// --- Videolar ---------------------------------------------------------------------------
const videoDir = (id) => path.join(VIDEOS_DIR, id);
const videoJson = (id) => path.join(videoDir(id), 'video.json');

function createVideo({ name, script, targetSeconds, hardPlanning, budget, aspect, movingProvider, assets }) {
  const settings = getSettings();
  const id = newId();
  const now = new Date().toISOString();
  const video = {
    id, createdAt: now, updatedAt: now,
    name: (name || '').trim(),
    script: String(script || '').trim(),
    targetSeconds: Number(targetSeconds) > 0 ? Number(targetSeconds) : 0, // 0 = Claude senaryodan çıkarsın
    hardPlanning: !!hardPlanning,
    budget: Number(budget) > 0 ? Number(budget) : settings.defaultBudget,
    aspect: ['16:9', '9:16', '1:1', 'auto'].includes(aspect) ? aspect : settings.aspect,
    movingProvider: movingProvider === 'flow' ? 'flow' : 'gemini',
    assets: {
      auto: !assets || assets.auto !== false,
      characters: (assets && assets.characters) || [],
      locations: (assets && assets.locations) || [],
      narrators: (assets && assets.narrators) || [],
    },
    approved: false,
    planning: false, planError: null, plan: null,
    shots: [], audio: [], costs: [],
    producing: false, assembling: false,
    final: null, finalStatus: '', finalError: null,
  };
  saveVideo(video);
  return video;
}
function getVideo(id) { return id && ID_RE.test(id) ? readJson(videoJson(id)) : null; }
function saveVideo(v) { v.updatedAt = new Date().toISOString(); writeJson(videoJson(v.id), v); return v; }
function updateVideo(id, mutator) { const v = getVideo(id); if (!v) throw new Error('Video bulunamadı'); mutator(v); return saveVideo(v); }
function listVideos() {
  ensureDir(VIDEOS_DIR);
  const items = [];
  for (const name of fs.readdirSync(VIDEOS_DIR)) { const v = getVideo(name); if (v) items.push(v); }
  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return items;
}
function deleteVideo(id) { if (!getVideo(id)) throw new Error('Video bulunamadı'); fs.rmSync(videoDir(id), { recursive: true, force: true }); }
const videoFile = (id, name) => path.join(videoDir(id), name);

module.exports = {
  DATA_DIR, ID_RE, shortId,
  getSettings, saveSettings, updateSettings,
  getLibrary, saveLibrary, updateLibrary, libFile,
  createVideo, getVideo, saveVideo, updateVideo, listVideos, deleteVideo, videoFile, videoDir,
};
