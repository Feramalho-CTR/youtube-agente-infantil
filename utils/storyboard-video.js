// Storyboard assembly: one narration clip per scene, and each scene's visual lasts exactly as long
// as its narration. Still images get a slow zoom/pan; a few key scenes can become AI video clips.

const fs = require('fs').promises;
const path = require('path');
const { getMediaDuration, runFFmpeg } = require('./ffmpeg');

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const SCENE_PADDING_SECONDS = 0.35;
// The scene editor rejects scenes shorter than this, so short lines are held on screen longer.
const MIN_SCENE_SECONDS = 2;
const MAX_SCENE_WORDS = 40;

function isStoryboardEnabled(env = process.env) {
  return String(env.VIDEO_ASSEMBLY || '').trim().toLowerCase() === 'storyboard';
}

function cleanLine(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Splits long text on sentence boundaries so no scene stays on screen for too long.
function splitIntoBeats(text) {
  const sentences = cleanLine(text).match(/[^.!?…]+[.!?…]*\s*/g) || [];
  const beats = [];
  let current = '';
  for (const sentence of sentences) {
    const candidate = `${current} ${sentence}`.trim();
    if (current && candidate.split(/\s+/).length > MAX_SCENE_WORDS) {
      beats.push(current.trim());
      current = sentence.trim();
    } else {
      current = candidate;
    }
  }
  if (current.trim()) beats.push(current.trim());
  return beats;
}

function sectionLines(section = {}) {
  if (Array.isArray(section.content)) return section.content.map(cleanLine).filter(Boolean);
  if (typeof section.content === 'string') return [cleanLine(section.content)].filter(Boolean);
  const items = section.items || section.steps || [];
  return items.map(item => cleanLine([item.title, item.description, item.tip].filter(Boolean).join('. '))).filter(Boolean);
}

function buildStoryboardScenes(script = {}) {
  const scenes = [];
  const add = (label, text) => {
    for (const beat of splitIntoBeats(text)) scenes.push({ label, scriptText: beat });
  };
  add('Hook', script.hook?.text || '');
  const intro = script.introduction || {};
  add('Introduction', [intro.greeting, intro.topicIntro, intro.valueProposition, intro.credibility].filter(Boolean).join(' '));
  for (const [index, section] of (script.mainContent?.sections || []).entries()) {
    for (const line of sectionLines(section)) add(section.title || `Scene ${index + 1}`, line);
  }
  const conclusion = script.conclusion || {};
  add('Conclusion', [...(conclusion.recap || []), conclusion.finalThought].filter(Boolean).join(' '));
  const cta = script.callToAction || {};
  add('Closing', [cta.subscribe, cta.like, cta.comment, cta.nextVideo].filter(value => typeof value === 'string').join(' '));
  return scenes.map((scene, position) => ({ ...scene, position }));
}

// Opening scene plus the scene at roughly 70% of the story (usually the climax).
function pickClipScenes(sceneCount, maxClips) {
  if (sceneCount === 0 || maxClips <= 0) return [];
  const picks = [0];
  if (maxClips > 1 && sceneCount > 2) picks.push(Math.min(sceneCount - 1, Math.round((sceneCount - 1) * 0.7)));
  return [...new Set(picks)].slice(0, maxClips);
}

// Alternating slow zoom-in, zoom-out and gentle pans keep stills alive without any provider cost.
function motionFilter(inputIndex, duration, variant, outputLabel) {
  const frames = Math.max(1, Math.round(duration * FPS));
  const step = (0.15 / frames).toFixed(6);
  const motions = [
    `z='min(zoom+${step},1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    `z='if(eq(on,0),1.15,max(zoom-${step},1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    `z='1.12':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)'`,
    `z='1.12':x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)'`
  ];
  return `[${inputIndex}:v]scale=${WIDTH * 2}:${HEIGHT * 2}:force_original_aspect_ratio=increase,crop=${WIDTH * 2}:${HEIGHT * 2},` +
    `zoompan=${motions[variant % motions.length]}:d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS},` +
    `trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p${outputLabel}`;
}

function clipFilter(inputIndex, duration, outputLabel) {
  return `[${inputIndex}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},fps=${FPS},` +
    `trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p${outputLabel}`;
}

function srtTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

function buildSrt(scenes) {
  let start = 0;
  return scenes.map((scene, index) => {
    const end = start + scene.duration;
    const block = `${index + 1}\n${srtTime(start)} --> ${srtTime(Math.max(start, end - SCENE_PADDING_SECONDS))}\n${scene.scriptText}\n`;
    start = end;
    return block;
  }).join('\n');
}

class StoryboardVideoService {
  constructor({ videoGenerator, aiTextService = null, logger = null, getDuration = getMediaDuration, ffmpeg = runFFmpeg, env = process.env }) {
    this.videoGenerator = videoGenerator;
    this.mediaGeneration = videoGenerator?.mediaGeneration || null;
    this.aiTextService = aiTextService;
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.getDuration = getDuration;
    this.ffmpeg = ffmpeg;
    this.env = env;
  }

  // One AI call turns every narration beat into a concrete English visual description.
  async describeVisuals(scenes, script = {}) {
    const fallback = scenes.map(scene => `${scene.label}. ${scene.scriptText}`);
    if (!this.aiTextService?.isAvailable?.()) return fallback;
    const prompt = `You are the storyboard artist for a children's animated story video titled "${script.title || ''}".
For each numbered narration line below, write one short English description of the single image that should be on screen while it is spoken.
Describe the setting, the characters and what they are doing. Keep recurring characters looking the same in every description (same names, colors and clothes). No text or letters in the images.
Return only a JSON array of strings with exactly ${scenes.length} items, in the same order.

${scenes.map((scene, index) => `${index + 1}. ${scene.scriptText}`).join('\n')}`;
    try {
      const response = await this.aiTextService.generateText(prompt, { maxTokens: 4000, temperature: 0.6 });
      const text = String(response || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || text);
      if (!Array.isArray(parsed) || parsed.length !== scenes.length) throw new Error('storyboard length mismatch');
      return parsed.map((value, index) => cleanLine(String(value || '')) || fallback[index]);
    } catch (error) {
      this.logger.warn(`Storyboard visual descriptions failed; using narration text as prompts: ${error.message}`);
      return fallback;
    }
  }

  async generateSceneImage(prompt, imagePath, style) {
    const enhanced = this.videoGenerator.enhanceVisualPrompt(prompt, style);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.videoGenerator.generateImage(enhanced, imagePath);
        return imagePath;
      } catch (error) {
        this.logger.warn(`Scene image attempt ${attempt} failed: ${error.message}`);
      }
    }
    return null;
  }

  async generateSceneClip({ jobId, productionId, scene, outputDir, remainingSeconds = Infinity }) {
    const media = this.mediaGeneration;
    if (!media) return null;
    const settings = await media.settings();
    if (settings.mode === 'slideshow' || settings.maxGeneratedSeconds === 0 || remainingSeconds < settings.clipDuration) return null;
    const routingRequest = { duration: settings.clipDuration, firstFrame: scene.assetPath, generateAudio: false };
    const provider = media.registry.select(settings.provider, settings.order, routingRequest);
    if (provider.id === 'slideshow') return null;
    const normalized = provider.normalizeRequest(routingRequest);
    if (normalized.duration > remainingSeconds) return null;
    const clipScene = { index: scene.position, label: scene.label, prompt: scene.prompt, duration: normalized.duration };
    const outputPath = path.join(outputDir, `${productionId}_${provider.id}_scene${String(scene.position).padStart(3, '0')}.mp4`);
    const result = await media.generateClip({
      jobId, productionId, scene: clipScene, provider, outputPath,
      request: {
        prompt: scene.prompt, duration: normalized.duration, firstFrame: scene.assetPath, referenceImages: [],
        resolution: settings.resolution, aspectRatio: '16:9', generateAudio: false
      }
    });
    return {
      path: result.outputPath, duration: normalized.duration, provider: provider.id,
      model: result.task.model || provider.model || null, taskId: result.task.external_task_id || null
    };
  }

  async produce({ productionId, jobId = null, script, voice = null, style, outputDir }) {
    const sceneDir = path.join(outputDir, `${productionId}_storyboard`);
    await fs.mkdir(sceneDir, { recursive: true });
    const scenes = buildStoryboardScenes(script);
    if (!scenes.length) throw new Error('The script has no narration to storyboard');

    const visuals = await this.describeVisuals(scenes, script);
    let lastImage = null;
    let narrationEvidence = null;
    for (const scene of scenes) {
      scene.prompt = visuals[scene.position];
      const id = String(scene.position).padStart(3, '0');

      const audioPath = path.join(sceneDir, `${id}_narration.mp3`);
      const generatedAudio = await this.videoGenerator.generateTTSAudio(scene.scriptText, audioPath, voice);
      if (!await this.videoGenerator.isUsableAudioFile(generatedAudio)) {
        throw new Error(`Narration for scene ${scene.position + 1} is unavailable; configure a live TTS provider`);
      }
      narrationEvidence = narrationEvidence || this.videoGenerator.lastNarrationResult || {};
      scene.audioPath = generatedAudio;
      scene.narrationDuration = await this.getDuration(generatedAudio);
      scene.duration = Number(Math.max(MIN_SCENE_SECONDS, scene.narrationDuration + SCENE_PADDING_SECONDS).toFixed(3));

      const imagePath = await this.generateSceneImage(scene.prompt, path.join(sceneDir, `${id}_image.png`), style);
      // A failed image reuses the previous scene's picture rather than dropping the beat.
      scene.assetPath = imagePath || lastImage;
      scene.assetType = 'image';
      if (!scene.assetPath) throw new Error(`No image could be generated for scene ${scene.position + 1}`);
      lastImage = scene.assetPath;
    }

    const maxClips = Math.max(0, Number(this.env.STORYBOARD_AI_CLIPS ?? 2));
    // The media service resolves the paid-seconds cap from the environment or the dashboard setting.
    const mediaSettings = maxClips > 0 && this.mediaGeneration ? await this.mediaGeneration.settings() : null;
    const budgetSeconds = Math.max(0, Number(mediaSettings?.maxGeneratedSeconds ?? 0));
    let generatedSeconds = 0;
    for (const index of pickClipScenes(scenes.length, maxClips)) {
      const scene = scenes[index];
      try {
        const clip = await this.generateSceneClip({ jobId, productionId, scene, outputDir: sceneDir, remainingSeconds: budgetSeconds - generatedSeconds });
        if (clip) {
          scene.clip = clip;
          generatedSeconds += clip.duration;
        }
      } catch (error) {
        this.logger.warn(`AI clip for scene ${index + 1} failed; keeping the animated image: ${error.message}`);
      }
    }

    const narrationPath = path.join(outputDir, `${productionId}_narration.m4a`);
    await this.concatNarration(scenes, narrationPath);
    return { scenes, narrationPath, narrationEvidence, totalDuration: scenes.reduce((sum, scene) => sum + scene.duration, 0) };
  }

  async concatNarration(scenes, outputPath) {
    const args = ['-y'];
    for (const scene of scenes) args.push('-i', scene.audioPath);
    const filters = scenes.map((scene, index) =>
      `[${index}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono,apad=whole_dur=${scene.duration.toFixed(3)}[a${index}]`);
    filters.push(`${scenes.map((_, index) => `[a${index}]`).join('')}concat=n=${scenes.length}:v=0:a=1[aout]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[aout]', '-c:a', 'aac', '-b:a', '160k', outputPath);
    await this.ffmpeg(args);
    return outputPath;
  }

  // Each scene becomes exactly `duration` seconds: an AI clip (then the animated still for any
  // remaining narration) or an animated still.
  async render(scenes, narrationPath, outputPath) {
    const args = ['-y'];
    const filters = [];
    const labels = [];
    let input = 0;
    for (const scene of scenes) {
      const clipSeconds = scene.clip ? Math.min(scene.clip.duration, scene.duration) : 0;
      if (clipSeconds > 0) {
        args.push('-i', scene.clip.path);
        const label = `[v${labels.length}]`;
        filters.push(clipFilter(input++, clipSeconds, label));
        labels.push(label);
      }
      const stillSeconds = scene.duration - clipSeconds;
      if (stillSeconds > 0.05) {
        args.push('-i', scene.assetPath);
        const label = `[v${labels.length}]`;
        filters.push(motionFilter(input++, stillSeconds, scene.position, label));
        labels.push(label);
      }
    }
    filters.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[vout]`);
    args.push('-i', narrationPath, '-filter_complex', filters.join(';'), '-map', '[vout]', '-map', `${input}:a`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', outputPath);
    await this.ffmpeg(args);
    return outputPath;
  }
}

module.exports = {
  StoryboardVideoService, buildStoryboardScenes, splitIntoBeats, pickClipScenes, buildSrt, motionFilter, isStoryboardEnabled
};
