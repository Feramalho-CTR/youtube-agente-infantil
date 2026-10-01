// Alternates narration between a male and a female voice, one voice per production.

const fs = require('fs').promises;
const path = require('path');

const DEFAULT_STATE_PATH = path.join(__dirname, '..', 'data', 'voice-rotation.json');

function configuredVoices(env = process.env) {
  const voices = {
    male: {
      gender: 'male',
      elevenLabsVoiceId: String(env.ELEVENLABS_VOICE_MALE || '').trim() || null,
      geminiVoice: String(env.GEMINI_TTS_VOICE_MALE || '').trim() || null,
      openaiVoice: String(env.OPENAI_TTS_VOICE_MALE || '').trim() || null
    },
    female: {
      gender: 'female',
      elevenLabsVoiceId: String(env.ELEVENLABS_VOICE_FEMALE || '').trim() || null,
      geminiVoice: String(env.GEMINI_TTS_VOICE_FEMALE || '').trim() || null,
      openaiVoice: String(env.OPENAI_TTS_VOICE_FEMALE || '').trim() || null
    }
  };
  const hasAny = voice => Boolean(voice.elevenLabsVoiceId || voice.geminiVoice || voice.openaiVoice);
  // Rotation is only meaningful when both genders have at least one voice configured.
  return hasAny(voices.male) && hasAny(voices.female) ? voices : null;
}

class VoiceRotation {
  constructor(options = {}) {
    this.statePath = options.statePath || DEFAULT_STATE_PATH;
    this.env = options.env || process.env;
  }

  async readLast() {
    try {
      const state = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
      return state.last === 'male' || state.last === 'female' ? state.last : null;
    } catch {
      return null;
    }
  }

  // Returns the opposite gender of the previous production and records it, or null when
  // rotation is not configured (the single default voice is used instead).
  async next() {
    const voices = configuredVoices(this.env);
    if (!voices) return null;
    const last = await this.readLast();
    const gender = last === 'male' ? 'female' : 'male';
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify({ last: gender, updatedAt: new Date().toISOString() }, null, 2));
    return voices[gender];
  }
}

module.exports = { VoiceRotation, configuredVoices };
