// ffmpeg işlemleri (ffmpeg-static ile; bilgisayarda ffmpeg kurulu olması gerekmez)
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');

const FONT_BOLD = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSans-Bold.ttf');
const FONT_REGULAR = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSans-Regular.ttf');

function run(args, opts) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg-static bulunamadı. `npm install` çalıştırın.'));
    const proc = spawn(ffmpegPath, ['-hide_banner', '-y', ...args], { windowsHide: true, cwd: opts && opts.cwd });
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); });
    proc.on('error', (e) => reject(new Error('ffmpeg çalıştırılamadı: ' + e.message)));
    proc.on('close', (code) => {
      if (code === 0) resolve(err);
      else reject(new Error('ffmpeg hatası (kod ' + code + '): ' + err.split('\n').filter(Boolean).slice(-4).join(' | ')));
    });
  });
}

function probe(file) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve('');
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true });
    let out = '';
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => resolve(''));
    proc.on('close', () => resolve(out));
  });
}
async function hasAudio(file) { return /Stream #\d+:\d+.*Audio/.test(await probe(file)); }
async function duration(file) {
  const m = (await probe(file)).match(/Duration: (\d+):(\d+):(\d+\.?\d*)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

async function extractAudio(videoFile, outFile) {
  await run(['-i', videoFile, '-vn', '-ac', '1', '-ar', '44100', '-b:a', '192k', outFile]);
  return outFile;
}
async function replaceAudio(videoFile, audioFile, outFile) {
  await run(['-i', videoFile, '-i', audioFile, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-shortest', outFile]);
  return outFile;
}

function targetSize(aspect) {
  if (aspect === '16:9') return { w: 1920, h: 1080 };
  if (aspect === '1:1') return { w: 1080, h: 1080 };
  return { w: 1080, h: 1920 };
}

// Filtre argümanı içindeki dosya yolları: ffmpeg proje kökünde çalıştırılır, yollar köke göre
// göreli verilir (iki nokta ve ters bölü kaçış sorunları olmasın).
const ROOT = path.join(__dirname, '..');
function ffPath(p) {
  const rel = path.relative(ROOT, path.resolve(p));
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
  return path.resolve(p).replace(/\\/g, '/').replace(/:/g, '\\:');
}
const fmt = (n) => Number(n).toFixed(3);

// Metni satırlara böler (drawtext otomatik sarmaz)
function wrap(text, maxChars) {
  const out = [];
  for (const para of String(text).replace(/\r/g, '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if ((line + ' ' + word).trim().length > maxChars && line) { out.push(line); line = word; }
      else line = (line + ' ' + word).trim();
    }
    out.push(line);
  }
  return out.join('\n');
}

let textSeq = 0;
// drawtext filtresi: metin dosyaya yazılır (kaçış sorunları olmasın), fontfile mutlak yol
function drawtext(dir, text, { font, size, color, x, y, box, alpha, enable }) {
  const file = path.join(dir, `txt-${process.pid}-${++textSeq}.txt`);
  fs.writeFileSync(file, text);
  const parts = [
    `textfile='${ffPath(file)}'`,
    `fontfile='${ffPath(font || FONT_BOLD)}'`,
    `fontsize=${size}`, `fontcolor=${color || 'white'}`,
    `x=${x || '(w-text_w)/2'}`, `y=${y || '(h-text_h)/2'}`,
    'line_spacing=10', 'text_align=center',
    'shadowcolor=black@0.6', 'shadowx=2', 'shadowy=2',
  ];
  if (box) parts.push('box=1', 'boxcolor=black@0.45', 'boxborderw=22');
  if (alpha) parts.push(`alpha='${alpha}'`);
  if (enable) parts.push(`enable='${enable}'`);
  return 'drawtext=' + parts.join(':');
}

// Ekran yazısı stilleri: hook (üst-orta, büyük, kalın), subtitle (alt), end_card (ortada, beyaz + altın)
function overlayFilter(dir, item, size, shotDur) {
  const { w, h } = size;
  const start = Math.max(0, Number(item.start) || 0);
  const dur = Number(item.duration) > 0 ? Number(item.duration) : Math.max(0.5, shotDur - start);
  const enable = `between(t,${fmt(start)},${fmt(start + dur)})`;
  if (item.style === 'subtitle') {
    const fs_ = Math.round(w * 0.034);
    return drawtext(dir, wrap(item.text, Math.round(w / (fs_ * 0.55))), { size: fs_, y: `h-text_h-${Math.round(h * 0.07)}`, box: true, enable, font: FONT_REGULAR });
  }
  if (item.style === 'end_card') {
    const main = Math.round(w * 0.045);
    return endCardFilters(dir, item.text, size, { enable, fadeIn: start, mainSize: main });
  }
  // hook
  const fs_ = Math.round(w * (w > h ? 0.05 : 0.062));
  return drawtext(dir, wrap(item.text, Math.round(w / (fs_ * 0.58))), { size: fs_, y: `${Math.round(h * 0.08)}`, box: true, enable });
}

// Kapanış kartı: ana metin beyaz, "—" ile başlayan son satır altın sarısı; yavaş fade-in
function endCardFilters(dir, text, size, { enable, fadeIn, mainSize }) {
  const { w } = size;
  const lines = String(text).replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  let attribution = '';
  if (lines.length > 1 && /^[—–-]/.test(lines[lines.length - 1])) attribution = lines.pop();
  const main = wrap(lines.join('\n'), Math.round(w / (mainSize * 0.55)));
  const t0 = fadeIn || 0;
  const alpha = `if(lt(t,${fmt(t0)}),0,min(1,(t-${fmt(t0)})/1.4))`;
  const f = [drawtext(dir, main, { size: mainSize, color: 'white', y: attribution ? '(h-text_h)/2-40' : '(h-text_h)/2', alpha, enable })];
  if (attribution) f.push(drawtext(dir, attribution, { size: Math.round(mainSize * 0.8), color: '#E6B84A', y: `(h-text_h)/2+${Math.round(mainSize * 1.6)}`, alpha, enable, font: FONT_REGULAR }));
  return f.join(',');
}

// Yazı kartı (yapay zeka değil): siyah/sade fon + yazı, sessiz video
async function textCard(dir, outFile, { text, style, seconds, aspect, bg }) {
  const size = targetSize(aspect);
  const dur = Math.max(1, Number(seconds) || 3);
  const main = Math.round(size.w * (style === 'end_card' ? 0.045 : 0.05));
  const vf = style === 'end_card'
    ? endCardFilters(dir, text, size, { enable: null, fadeIn: 0, mainSize: main })
    : drawtext(dir, wrap(text, Math.round(size.w / (main * 0.55))), { size: main, box: false });
  await run(['-f', 'lavfi', '-i', `color=c=${bg || 'black'}:s=${size.w}x${size.h}:r=30:d=${fmt(dur)}`, '-vf', `${vf},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-t', fmt(dur), path.resolve(outFile)], { cwd: ROOT });
  return outFile;
}

// Bölüm renk tonu
function gradeFilter(grade) {
  switch (grade) {
    case 'cold': return 'colorbalance=rs=-0.08:gs=-0.02:bs=0.12:rm=-0.04:bm=0.06,eq=saturation=0.9';
    case 'warm': return 'colorbalance=rs=0.1:gs=0.03:bs=-0.1:rm=0.05:bm=-0.05';
    case 'desaturated': return 'eq=saturation=0.35:contrast=1.05';
    case 'dark': return 'eq=brightness=-0.06:contrast=1.08:saturation=0.85';
    case 'vivid': return 'eq=saturation=1.3:contrast=1.05';
    default: return '';
  }
}

// Anlatıcı sesini tek klibin üstüne bindirir (eski akış; sahne bazlı)
async function mixNarration(videoFile, narrationFile, outFile) {
  const dv = await duration(videoFile);
  const dn = await duration(narrationFile);
  const audio = await hasAudio(videoFile);
  const pad = Math.max(0, dn + 0.4 - dv);
  const vf = pad > 0 ? `tpad=stop_mode=clone:stop_duration=${pad.toFixed(2)}` : 'null';
  const fc = audio
    ? `[0:v]${vf}[v];[0:a]volume=0.2[bg];[bg][1:a]amix=inputs=2:duration=longest:dropout_transition=0[a]`
    : `[0:v]${vf}[v];[1:a]anull[a]`;
  const args = ['-i', videoFile, '-i', narrationFile, '-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart'];
  if (pad === 0 && dn < dv) args.push('-t', String(dv.toFixed(2)));
  args.push(outFile);
  await run(args);
  return outFile;
}

// Tek klibi hedef çözünürlüğe getir (siyah bant yok), 30 fps, sessizse sessiz ses ekle
async function normalizeClip(inputFile, outFile, aspect) {
  const { w, h } = targetSize(aspect);
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=30,format=yuv420p`;
  const audio = await hasAudio(inputFile);
  const args = ['-i', inputFile];
  if (!audio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  args.push('-map', '0:v:0', '-map', audio ? '0:a:0' : '1:a:0', '-vf', vf, '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart');
  if (!audio) args.push('-shortest');
  args.push(outFile);
  await run(args);
  return outFile;
}

async function concatClips(files, outFile) {
  if (!files.length) throw new Error('Birleştirilecek klip yok');
  const listFile = path.join(path.dirname(outFile), 'concat-list.txt');
  fs.writeFileSync(listFile, files.map((f) => "file '" + path.resolve(f).replace(/\\/g, '/').replace(/'/g, "'\\''") + "'").join('\n') + '\n');
  await run(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', outFile]);
  return outFile;
}

// ---------------------------------------------------------------------------------------
// Otomatik yönetmen birleştirmesi.
// timeline = {
//   aspect, dir (çalışma klasörü), outFile,
//   shots: [{ file, duration, grade, overlays: [{text, style, start, duration}], sectionStart: bool, sectionEnd: bool }],
//   voiceovers: [{ file, at }],            // mutlak saniye
//   music: [{ file, start, end, kind: 'music'|'sfx' }],
//   silences: [{ start, end }],
//   fadeOutSeconds
// }
// Çıktı: 30 fps H.264 + AAC; diyalog/dış ses konuşurken müzik otomatik kısılır (sidechain ducking).
async function assemble(tl) {
  const size = targetSize(tl.aspect);
  const { w, h } = size;
  const inputs = [];
  const fc = [];
  const shots = tl.shots;
  if (!shots.length) throw new Error('Birleştirilecek çekim yok');
  const total = shots.reduce((n, s) => n + s.duration, 0);

  // Video + klip sesi
  const vLabels = [], aLabels = [];
  let t = 0;
  const boundaries = [];
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    inputs.push('-i', s.file);
    const idx = inputs.length / 2 - 1;
    let v = `[${idx}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=30,setsar=1,format=yuv420p,trim=0:${fmt(s.duration)},setpts=PTS-STARTPTS`;
    const g = gradeFilter(s.grade);
    if (g) v += ',' + g;
    for (const o of s.overlays || []) v += ',' + overlayFilter(tl.dir, o, size, s.duration);
    if (s.duration > 0.1) v += `,tpad=stop_mode=clone:stop_duration=0.5,trim=0:${fmt(s.duration)}`; // kısa gelirse son kareyle doldur
    // Bölüm geçişlerinde kararma (klip bazında: bölüm sonunda fade out, yeni bölüm başında fade in), sonda kararma
    const prevEnded = i > 0 && shots[i - 1].sectionEnd;
    if (prevEnded) v += ',fade=t=in:st=0:d=0.5';
    const fo = tl.fadeOutSeconds == null ? 1.2 : tl.fadeOutSeconds;
    if (i === shots.length - 1 && fo > 0) v += `,fade=t=out:st=${fmt(Math.max(0, s.duration - fo))}:d=${fmt(fo)}`;
    else if (s.sectionEnd) v += `,fade=t=out:st=${fmt(Math.max(0, s.duration - 0.5))}:d=0.5`;
    fc.push(`${v}[v${i}]`);
    vLabels.push(`[v${i}]`);
    if (s.hasAudio) fc.push(`[${idx}:a]aformat=sample_rates=44100:channel_layouts=stereo,apad,atrim=0:${fmt(s.duration)},asetpts=PTS-STARTPTS[a${i}]`);
    else fc.push(`aevalsrc=0:d=${fmt(s.duration)}:s=44100,aformat=channel_layouts=stereo[a${i}]`);
    aLabels.push(`[a${i}]`);
    t += s.duration;
    if (s.sectionEnd && i < shots.length - 1) boundaries.push(t);
  }
  fc.push(`${vLabels.join('')}concat=n=${shots.length}:v=1:a=0[v]`);
  fc.push(`${aLabels.join('')}concat=n=${shots.length}:v=0:a=1[clipa]`);
  void boundaries;

  // Dış sesler
  const voLabels = [];
  for (const vo of tl.voiceovers || []) {
    inputs.push('-i', vo.file);
    const idx = inputs.length / 2 - 1;
    const ms = Math.round(Math.max(0, vo.at) * 1000);
    fc.push(`[${idx}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${ms}|${ms}[vo${voLabels.length}]`);
    voLabels.push(`[vo${voLabels.length}]`);
  }
  if (voLabels.length) fc.push(`[clipa]${voLabels.join('')}amix=inputs=${voLabels.length + 1}:normalize=0:duration=first[speech]`);
  else fc.push('[clipa]anull[speech]');

  // Müzik ve efektler
  const musLabels = [], sfxLabels = [];
  for (const m of tl.music || []) {
    const len = Math.max(0.5, Math.min(total, m.end) - m.start);
    if (len <= 0 || m.start >= total) continue;
    inputs.push('-stream_loop', '-1', '-i', m.file);
    const idx = inputs.length / 3 + (inputs.length % 3 ? 0 : 0); // hesap aşağıda
    const realIdx = countInputs(inputs) - 1;
    const ms = Math.round(m.start * 1000);
    const fadeIn = m.kind === 'sfx' ? 0.05 : 1.0, fadeOut = m.kind === 'sfx' ? 0.2 : 1.5;
    const vol = m.kind === 'sfx' ? 0.9 : (m.volume || 0.7);
    const label = m.kind === 'sfx' ? `sfx${sfxLabels.length}` : `mus${musLabels.length}`;
    fc.push(`[${realIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,atrim=0:${fmt(len)},asetpts=PTS-STARTPTS,afade=t=in:d=${fadeIn},afade=t=out:st=${fmt(Math.max(0, len - fadeOut))}:d=${fadeOut},volume=${vol},adelay=${ms}|${ms}[${label}]`);
    (m.kind === 'sfx' ? sfxLabels : musLabels).push(`[${label}]`);
    void idx;
  }
  const silence = (tl.silences || []).filter((s) => s.end > s.start).map((s) => `between(t,${fmt(s.start)},${fmt(s.end)})`).join('+');
  const finalInputs = ['[sp1]'];
  if (musLabels.length) {
    fc.push(`${musLabels.join('')}${musLabels.length > 1 ? `amix=inputs=${musLabels.length}:normalize=0:duration=longest` : 'anull'}${silence ? `,volume=0:enable='${silence}'` : ''}[musmix]`);
    fc.push('[speech]asplit=2[sp1][sp2]');
    fc.push('[musmix][sp2]sidechaincompress=threshold=0.02:ratio=8:attack=80:release=700:makeup=1[ducked]');
    finalInputs.push('[ducked]');
  } else {
    fc.push('[speech]anull[sp1]');
  }
  if (sfxLabels.length) {
    fc.push(`${sfxLabels.join('')}${sfxLabels.length > 1 ? `amix=inputs=${sfxLabels.length}:normalize=0:duration=longest` : 'anull'}[sfxmix]`);
    finalInputs.push('[sfxmix]');
  }
  if (finalInputs.length > 1) fc.push(`${finalInputs.join('')}amix=inputs=${finalInputs.length}:normalize=0:duration=first[aout]`);
  else fc.push('[sp1]anull[aout]');

  const graphFile = path.join(tl.dir, 'assemble-graph.txt');
  fs.writeFileSync(graphFile, fc.join(';\n'));
  const args = [...inputs.map((a) => (a === '-i' || a === '-stream_loop' || a === '-1' ? a : path.resolve(a))), '-filter_complex_script', graphFile, '-map', '[v]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', '-t', fmt(total), path.resolve(tl.outFile)];
  await run(args, { cwd: ROOT });
  return tl.outFile;
}
function countInputs(inputs) { let n = 0; for (let i = 0; i < inputs.length; i++) if (inputs[i] === '-i') n++; return n; }

module.exports = { run, hasAudio, duration, extractAudio, replaceAudio, mixNarration, normalizeClip, concatClips, targetSize, textCard, assemble, wrap, ffmpegPath, FONT_BOLD, FONT_REGULAR };
