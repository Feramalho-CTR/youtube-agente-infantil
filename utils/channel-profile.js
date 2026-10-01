// Channel-wide content profile: language and audience policy shared by every agent.

const LANGUAGE_NAMES = {
  en: 'English',
  'pt-BR': 'Brazilian Portuguese',
  pt: 'Portuguese',
  es: 'Spanish'
};

const KIDS_TEXT_RULES = [
  'The audience is young children (roughly 3 to 8 years old). Everything must be safe, kind, and age-appropriate.',
  'Never include violence, weapons, scary or horror elements, jump scares, dangerous stunts, pranks, injuries, or anything a child could imitate and get hurt.',
  'Never include romance, bad language, insults, bullying presented as funny, alcohol, drugs, gambling, or adult themes.',
  'Never ask children for personal information, to leave comments, to buy anything, or to click links. Do not include sponsorships or product placement.',
  'Never use copyrighted or trademarked characters, brands, or songs (for example Disney, Peppa Pig, Paw Patrol, Bluey, Cocomelon). Create original characters and original lyrics only.',
  'Prefer simple sentences, a warm and cheerful tone, repetition that helps learning, and a clear positive or educational takeaway.'
];

const KIDS_VISUAL_RULES = 'Child-friendly, bright and colorful, soft rounded shapes, friendly expressive characters, wholesome and safe. ' +
  'No violence, no scary or dark imagery, no weapons, no realistic injuries, no brand logos, no copyrighted characters.';

function readBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|sim|on)$/i.test(String(value).trim());
}

function getChannelProfile(env = process.env) {
  const language = String(env.CONTENT_LANGUAGE || 'en').trim() || 'en';
  return {
    language,
    languageName: LANGUAGE_NAMES[language] || language,
    captionsName: env.CAPTIONS_NAME || (language.startsWith('pt') ? 'Português' : `${LANGUAGE_NAMES[language] || language} captions`),
    madeForKids: readBoolean(env.MADE_FOR_KIDS, false),
    theme: String(env.CHANNEL_THEME || '').trim(),
    values: String(env.CHANNEL_VALUES || '').trim(),
    narrationStyle: String(env.NARRATION_STYLE || '').trim(),
    visualStyle: String(env.VISUAL_STYLE || '').trim()
  };
}

// English template text and generic calls to action cannot satisfy a localized or kids profile.
function requiresGeneratedText(profile = getChannelProfile()) {
  return profile.language !== 'en' || profile.madeForKids;
}

function textPolicyPreamble(profile = getChannelProfile()) {
  const lines = [];
  if (profile.language !== 'en') {
    lines.push(`Write every piece of audience-facing text (spoken narration, titles, descriptions, tags, hashtags, on-screen text, captions) in ${profile.languageName}. Keep JSON keys and any requested structure exactly as specified in English.`);
  }
  if (profile.madeForKids) lines.push(...KIDS_TEXT_RULES);
  if (profile.theme) lines.push(`Every video belongs to this channel format: ${profile.theme}`);
  if (profile.values) lines.push(`Every story must teach these values in a natural, gentle way: ${profile.values}`);
  if (profile.narrationStyle) lines.push(`Narration voice and tone: ${profile.narrationStyle}`);
  if (!lines.length) return '';
  return `Channel content policy (always follow):\n- ${lines.join('\n- ')}\n\n`;
}

function applyTextPolicy(prompt, profile = getChannelProfile()) {
  const preamble = textPolicyPreamble(profile);
  if (!preamble || typeof prompt !== 'string') return prompt;
  return `${preamble}${prompt}`;
}

function applyVisualPolicy(prompt, profile = getChannelProfile()) {
  if (typeof prompt !== 'string') return prompt;
  const additions = [];
  if (profile.visualStyle && !prompt.includes(profile.visualStyle)) additions.push(`Visual style: ${profile.visualStyle}.`);
  if (profile.madeForKids) additions.push(KIDS_VISUAL_RULES);
  if (!additions.length) return prompt;
  return `${prompt.trim()} ${additions.join(' ')}`;
}

module.exports = { getChannelProfile, applyTextPolicy, applyVisualPolicy, textPolicyPreamble, requiresGeneratedText, readBoolean };
