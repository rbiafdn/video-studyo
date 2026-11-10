// Anthropic Claude – otomatik yönetmen: serbest formatlı senaryoyu okur, çekim listesi (JSON) çıkarır,
// her çekim için aracı seçer, ses katmanlarını ve uyarıları yazar.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const MODEL_HARD = process.env.CLAUDE_MODEL_HARD || 'claude-opus-5-5';

const SYSTEM_PROMPT = `You are an experienced film director and prompt engineer running an AI video pipeline that produces Turkish-language videos. You receive a free-form Turkish script (it may contain a title, target duration, music notes, sections, camera/acting tips, voice-over, dialogue and on-screen text) plus the studio's asset library (characters with fixed looks and voices, locations with fixed looks, narrators). You return ONLY a JSON shot list. No prose, no markdown.

TOOLS (choose one per shot, put a one-sentence Turkish reason in tool_reason):
- "avatar": static or nearly static camera, exactly ONE person in frame speaking, long speech. Pipeline: first frame image → ElevenLabs speech with the character's fixed voice → lip-synced avatar video. Length = speech length. Use for monologues, pieces to camera, calm dialogue lines longer than ~8 seconds.
- "motion": camera movement + speech/acting, strong emotion (shouting, crying), two people interacting. Pipeline: first frame image → image-to-video model (Google Gemini automatically, or Google Flow by hand; the studio decides) with native audio; a single speaker's voice is later converted to the character's fixed voice. MAX 8 seconds per shot. If the action or dialogue is longer, split into several motion shots, ONE line of dialogue per shot.
- "seedance": movement without speech: establishing shots, atmosphere, transitions, b-roll, action without dialogue. Silent video (sound comes from the audio layers). 4–8 seconds.
- "text_card": plain text on a black/simple background rendered by ffmpeg (no AI): opening hook, closing quote, end card. 2–6 seconds. ON-SCREEN TEXT MUST NEVER BE WRITTEN INTO IMAGE OR VIDEO PROMPTS; text is always overlaid later from onscreen_text.
Voice-over (narrator) is NOT a tool: put narrator lines in "voiceover" of the shot where they start; they are generated separately and laid over the timeline. Voice-over may run over seedance/motion shots. Do not put voice-over on avatar shots.

RULES
1. Sections: split the script into sections with start/end seconds, a color_grade (none|cold|warm|desaturated|dark|vivid) derived from the script's tone notes ("soğuk mavi" → cold, "sıcak/altın" → warm, "siyah beyaz" → desaturated), color_note (Turkish) and music_note (Turkish).
2. Shots: ordered, ids from 1, start times cumulative, duration realistic. Speech timing: Turkish ≈ 2.5 words per second (≈14 characters/second); crying/shouting is slower (≈2 words/second). avatar shot duration = speech seconds + 1. Total should match target_duration (from the script if stated, else the given target; if neither, choose a natural length).
3. Characters and locations: use the library names EXACTLY in "characters" and "location" when the script's people/places match them (even if the script uses a nickname or a role, e.g. "Hoca" = the library's "Timurtaş Hoca"). If the script needs a person that is not in the library, add them to new_characters with a dense English physical description and use that name. If you are not sure which library asset a script name refers to, add a Turkish question to "questions" and pick the most likely match.
4. image_prompt: English, very detailed, photorealistic, cinematic first frame: repeat the character's fixed description word for word, the location's fixed description word for word, lighting, lens, camera angle, mood; fill the aspect ratio completely (no black bars, no letterbox, no text, no watermark, no subtitles). Avatar shots: single person from chest/waist up facing camera, mouth closed, neutral expression, nobody else in frame.
5. video_prompt (motion/seedance): English; camera movement, blocking, acting and emotion notes, timing within the shot; spoken lines in Turkish inside quotes, e.g. Ahmet says (shouting, voice breaking): "…". For seedance say explicitly that nobody speaks and there is no on-screen text. For avatar and text_card leave video_prompt empty.
6. dialogue: on-camera speech for the shot: [{speaker, line, emotion}] with emotion as a short Turkish note (bağırma, hıçkırık, fısıltı, kırık ses, sakin, öfke…) or empty. avatar shots: exactly one speaker. seedance/text_card: empty.
7. voiceover: [{narrator, line, style}] with narrator = a library narrator name (if none exists, use "Anlatıcı"), style short Turkish note.
8. onscreen_text: [{text, style, start, duration}] where style is "hook" (big bold text top-centre over the picture), "subtitle" (bottom caption) or "end_card" (centred text on black; attribution line starting with "—" is rendered in gold). start/duration are relative to the shot. text_card shots must have exactly one onscreen_text item (style hook or end_card) whose duration covers the shot. Quotes, hadith, verses and statistics are copied verbatim from the script; never alter them.
9. audio layers: music / sfx / silence segments with absolute start/end seconds and a Turkish description that also works as a generation prompt (e.g. "gergin, yavaş keman, minör, gerilim artıyor"). source: "library:<etiket>" if the library has a matching tagged file (match on tags), otherwise "generate". Use "silence" for parts the script wants without music. Music segments should not overlap each other.
10. warnings (Turkish, concrete, one sentence each): (a) dialogue + voice-over that does not fit a section or shot (give the seconds and a shortening suggestion); (b) total duration exceeding the target; (c) religious quotations, hadith, verses, statistics or other fact-sensitive text → "Bu metnin kaynağını ve lafzını yayından önce doğrulayın: '…'"; (d) content that video models may filter (violence, physical threat, weapons, blood) → suggest a safer prompt wording; (e) text_card used where the script expected a filmed shot, or any script instruction you could not honor.
11. aspect: "9:16" if the script mentions Shorts/Reels/TikTok/dikey, "16:9" for YouTube/TV/yatay, "1:1" for kare; otherwise the given default.
12. Output valid JSON matching the schema exactly. Empty strings / empty arrays for fields that do not apply.`;

const str = { type: 'string' };
const num = { type: 'number' };
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: str,
    aspect: { type: 'string', enum: ['16:9', '9:16', '1:1'] },
    target_duration: { type: 'integer' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, name: str, start: num, end: num, color_grade: { type: 'string', enum: ['none', 'cold', 'warm', 'desaturated', 'dark', 'vivid'] }, color_note: str, music_note: str },
        required: ['id', 'name', 'start', 'end', 'color_grade', 'color_note', 'music_note'],
        additionalProperties: false,
      },
    },
    shots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, section_id: { type: 'integer' }, start: num, duration: num,
          description: str, camera: str,
          characters: { type: 'array', items: str }, location: str,
          dialogue: { type: 'array', items: { type: 'object', properties: { speaker: str, line: str, emotion: str }, required: ['speaker', 'line', 'emotion'], additionalProperties: false } },
          voiceover: { type: 'array', items: { type: 'object', properties: { narrator: str, line: str, style: str }, required: ['narrator', 'line', 'style'], additionalProperties: false } },
          onscreen_text: { type: 'array', items: { type: 'object', properties: { text: str, style: { type: 'string', enum: ['hook', 'end_card', 'subtitle'] }, start: num, duration: num }, required: ['text', 'style', 'start', 'duration'], additionalProperties: false } },
          tool: { type: 'string', enum: ['avatar', 'motion', 'seedance', 'text_card'] },
          tool_reason: str, image_prompt: str, video_prompt: str,
        },
        required: ['id', 'section_id', 'start', 'duration', 'description', 'camera', 'characters', 'location', 'dialogue', 'voiceover', 'onscreen_text', 'tool', 'tool_reason', 'image_prompt', 'video_prompt'],
        additionalProperties: false,
      },
    },
    audio: {
      type: 'array',
      items: { type: 'object', properties: { type: { type: 'string', enum: ['music', 'sfx', 'silence'] }, description: str, start: num, end: num, source: str }, required: ['type', 'description', 'start', 'end', 'source'], additionalProperties: false },
    },
    warnings: { type: 'array', items: str },
    questions: { type: 'array', items: str },
    new_characters: { type: 'array', items: { type: 'object', properties: { name: str, description: str }, required: ['name', 'description'], additionalProperties: false } },
  },
  required: ['title', 'aspect', 'target_duration', 'sections', 'shots', 'audio', 'warnings', 'questions', 'new_characters'],
  additionalProperties: false,
};

function isConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

function turkishError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Claude: API anahtarı geçersiz (ANTHROPIC_API_KEY).';
  if (err instanceof Anthropic.RateLimitError) return 'Claude: istek sınırı aşıldı, biraz sonra tekrar deneyin.';
  if (err instanceof Anthropic.BadRequestError) return 'Claude: geçersiz istek (model adı doğru mu?). ' + err.message;
  if (err instanceof Anthropic.APIError) return `Claude API hatası (${err.status}): ${err.message}`;
  return 'Claude: ' + (err && err.message ? err.message : String(err));
}

async function callClaude(client, model, messages, useFallback) {
  const params = {
    model, max_tokens: 32000,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: PLAN_SCHEMA } },
  };
  if (useFallback) return client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }).finalMessage();
  return client.messages.stream(params).finalMessage();
}
const extractText = (r) => r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.shots) || !plan.shots.length) throw new Error('Planda çekim yok');
  for (const k of ['sections', 'audio', 'warnings', 'questions', 'new_characters']) if (!Array.isArray(plan[k])) plan[k] = [];
  plan.title = plan.title || '';
  if (!['16:9', '9:16', '1:1'].includes(plan.aspect)) plan.aspect = '16:9';
  let t = 0;
  plan.shots.forEach((s, i) => {
    s.id = i + 1;
    if (!['avatar', 'motion', 'seedance', 'text_card'].includes(s.tool)) s.tool = 'motion';
    for (const f of ['description', 'camera', 'location', 'tool_reason', 'image_prompt', 'video_prompt']) s[f] = s[f] || '';
    for (const f of ['characters', 'dialogue', 'voiceover', 'onscreen_text']) if (!Array.isArray(s[f])) s[f] = [];
    const speech = s.dialogue.reduce((n, d) => n + (d.line || '').length, 0);
    let dur = Number(s.duration) || 0;
    if (s.tool === 'avatar') dur = Math.max(dur, Math.ceil(speech / 14) + 1, 3);
    if (s.tool === 'motion') dur = Math.min(8, Math.max(3, dur || 6));
    if (s.tool === 'seedance') dur = Math.min(8, Math.max(4, dur || 5));
    if (s.tool === 'text_card') {
      dur = Math.min(8, Math.max(2, dur || 3));
      if (!s.onscreen_text.length) s.onscreen_text = [{ text: s.description, style: 'hook', start: 0, duration: dur }];
    }
    s.duration = Math.round(dur * 10) / 10;
    s.start = Math.round(t * 10) / 10;
    t += s.duration;
    s.section_id = Number(s.section_id) || (plan.sections[0] ? plan.sections[0].id : 1);
  });
  plan.target_duration = Number(plan.target_duration) || Math.round(t);
  if (!plan.sections.length) plan.sections = [{ id: 1, name: 'Bölüm 1', start: 0, end: t, color_grade: 'none', color_note: '', music_note: '' }];
  return plan;
}

function usageOf(model, ...responses) {
  const u = { model, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  for (const r of responses) {
    if (!r || !r.usage) continue;
    if (r.model) u.model = r.model;
    for (const k of Object.keys(u)) if (k !== 'model') u[k] += r.usage[k] || 0;
  }
  return u;
}

// assets: { characters: [{name, description, voiceNote}], locations: [{name, description}], narrators: [{name}], audio: [{name, tags}] }
function buildUserMessage(settings, assets, video) {
  const list = (arr, f) => (arr.length ? arr.map(f).join('\n') : '(none)');
  return [
    `Default aspect ratio: ${video.aspect && video.aspect !== 'auto' ? video.aspect : (settings.aspect && settings.aspect !== 'auto' ? settings.aspect : '16:9')}`,
    `Target duration: ${video.targetSeconds > 0 ? video.targetSeconds + ' seconds' : 'take it from the script if stated, otherwise choose'}`,
    `Studio style notes:\n${settings.notes || '(none)'}`,
    '',
    'LIBRARY — characters (name: fixed description | voice note):',
    list(assets.characters, (c) => `- ${c.name}: ${c.description || '(no description; write one in image prompts)'}${c.voiceNote ? ' | voice: ' + c.voiceNote : ''}`),
    'LIBRARY — locations (name: fixed description):',
    list(assets.locations, (l) => `- ${l.name}: ${l.description || '(no description)'}`),
    'LIBRARY — narrators (voice-over):',
    list(assets.narrators, (n) => `- ${n.name}`),
    'LIBRARY — music / sfx files (name: tags):',
    list(assets.audio || [], (a) => `- ${a.name}: ${a.tags || ''}`),
    '',
    `SCRIPT:\n${video.script}`,
  ].join('\n');
}

// Dönen: { plan, usage }
async function planVideo(settings, assets, video) {
  if (!isConfigured()) throw new Error('ANTHROPIC_API_KEY tanımlı değil.');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = video.hardPlanning ? MODEL_HARD : MODEL;
  const messages = [{ role: 'user', content: buildUserMessage(settings, assets, video) }];
  let response;
  try {
    try { response = await callClaude(client, model, messages, true); }
    catch (err) { if (err instanceof Anthropic.BadRequestError) response = await callClaude(client, model, messages, false); else throw err; }
  } catch (err) { throw new Error(turkishError(err)); }
  if (response.stop_reason === 'refusal') throw new Error('Claude bu senaryoyu işlemeyi reddetti.');
  if (response.stop_reason === 'max_tokens') throw new Error('Claude cevabı çok uzun oldu, senaryoyu kısaltıp tekrar deneyin.');
  let text = extractText(response);
  try { return { plan: validatePlan(JSON.parse(text)), usage: usageOf(model, response) }; }
  catch (firstErr) {
    messages.push({ role: 'assistant', content: text || '{}' });
    messages.push({ role: 'user', content: 'The previous answer was not a valid JSON shot list (' + firstErr.message + '). Return ONLY the corrected JSON.' });
    let second;
    try { second = await callClaude(client, model, messages, false); } catch (err) { throw new Error(turkishError(err)); }
    text = extractText(second);
    try { return { plan: validatePlan(JSON.parse(text)), usage: usageOf(model, response, second) }; }
    catch (err2) { throw new Error('Claude geçerli bir JSON çekim listesi döndürmedi: ' + err2.message); }
  }
}

module.exports = { planVideo, validatePlan, isConfigured, MODEL, MODEL_HARD };
