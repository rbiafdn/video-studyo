// Görünüm (look) ön ayarları: her görsel/video promptunun sonuna eklenen stil cümlesi
// + birleştirmede tüm klibe uygulanan ffmpeg "film" tonu. Ayarlar → Görünüm'den seçilir.
const PRESETS = {
  film: {
    name: 'Sinema filmi (gerçekçi, Anadolu dramı)',
    image: 'Style: a single frame from a cinematic feature film, not a photo shoot. Shot on 35mm film with an ARRI Alexa and a 40mm anamorphic lens, shallow depth of field with the background softly out of focus, eye-level medium close-up framing with the subject slightly off-centre. Soft natural window light, no studio flash, gentle haze in the air, low-contrast highlights, deep but soft shadows. Muted, desaturated film color palette (faded greens, greys, warm browns, natural skin tones), subtle film grain, slight vignette. Lived-in Anatolian production design: worn surfaces, peeling plaster, dust, period-accurate props and clothing with visible fabric texture. Real skin texture with pores and lines, no beauty retouching, no glossy plastic look, no oversaturation, no HDR, no text.',
    video: 'Cinematic feature-film look: handheld or slow dolly, shallow depth of field, soft natural light, muted desaturated film palette, subtle film grain, realistic micro-expressions and natural acting, no stylised effects.',
    grade: 'eq=saturation=0.8:contrast=0.95:brightness=0.01,colorbalance=rs=0.02:gs=0.0:bs=-0.03:rm=0.01:bm=-0.02:gh=0.02:bh=-0.02,noise=alls=6:allf=t+u,vignette=PI/5',
  },
  documentary: {
    name: 'Belgesel (doğal, kuru ışık)',
    image: 'Style: documentary photograph, natural available light, 35mm lens, true-to-life colors, moderate depth of field, honest unretouched faces, real locations, no studio lighting, no text.',
    video: 'Documentary look: observational handheld camera, natural light, true colors, no stylised effects.',
    grade: 'eq=saturation=0.92:contrast=0.98',
  },
  clean: {
    name: 'Temiz reklam (parlak, keskin)',
    image: 'Style: polished commercial photography, crisp focus, bright clean lighting, vivid but natural colors, no text.',
    video: 'Polished commercial look, smooth camera, bright clean lighting.',
    grade: '',
  },
  none: { name: 'Yok (sadece promptlar)', image: '', video: '', grade: '' },
};

function preset(settings) {
  const key = settings && PRESETS[settings.look] ? settings.look : 'film';
  const p = PRESETS[key];
  const custom = settings && typeof settings.lookCustom === 'string' ? settings.lookCustom.trim() : '';
  return { key, name: p.name, image: [p.image, custom].filter(Boolean).join(' '), video: [p.video, custom].filter(Boolean).join(' '), grade: p.grade };
}

// Prompt sonuna stil cümlesini ekler (zaten varsa tekrar eklemez).
function imagePrompt(prompt, settings) {
  const p = preset(settings);
  if (!p.image || String(prompt).includes(p.image.slice(0, 40))) return prompt;
  return String(prompt).trim() + '\n\n' + p.image;
}
function videoPrompt(prompt, settings) {
  const p = preset(settings);
  if (!p.video || String(prompt).includes(p.video.slice(0, 40))) return prompt;
  return String(prompt).trim() + ' ' + p.video;
}
function gradeFilter(settings) { return preset(settings).grade; }
// Video kendi görünümünü seçtiyse onu, yoksa genel ayarı kullan.
function forVideo(settings, video) {
  const s = Object.assign({}, settings || {});
  if (video && video.look && PRESETS[video.look]) s.look = video.look;
  if (video && typeof video.lookCustom === 'string' && video.lookCustom.trim()) s.lookCustom = video.lookCustom;
  return s;
}
function list() { return Object.entries(PRESETS).map(([k, v]) => ({ key: k, name: v.name })); }

module.exports = { PRESETS, preset, imagePrompt, videoPrompt, gradeFilter, forVideo, list };
