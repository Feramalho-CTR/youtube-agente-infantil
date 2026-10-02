const { applyTextPolicy } = require('./channel-profile');
const OpenAI = require('openai');
const { Logger } = require('./logger');

const GEMINI_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash-lite',
];
const GEMINI_DEFAULT_MODEL = GEMINI_MODELS[0];

const OMNIROUTE_DEFAULT_BASE_URL = 'http://localhost:20128/v1';

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6',
    models: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    envKey: 'OPENAI_API_KEY',
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.6-sol',
    models: ['openai/gpt-5.6-sol', 'anthropic/claude-fable-5', 'google/gemini-3.7-flash', 'moonshotai/kimi-k3', 'z-ai/glm-5.3'],
    envKey: 'OPENROUTER_API_KEY',
  },
  kimi: {
    name: 'Kimi (Moonshot AI)',
    baseURL: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    envKey: 'MOONSHOT_API_KEY',
  },
  mimo: {
    name: 'MiMo (Xiaomi)',
    baseURL: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
    envKey: 'MIMO_API_KEY',
  },
  glm: {
    name: 'GLM (Zhipu AI)',
    baseURL: 'https://api.z.ai/api/paas/v4/',
    defaultModel: 'glm-5.3',
    models: ['glm-5.3', 'glm-5.2', 'glm-5.1'],
    envKey: 'GLM_API_KEY',
  },
  // OmniRoute (github.com/diegosouzapw/OmniRoute) is a local gateway that spreads
  // requests across many free-tier providers. With OMNIROUTE_API_KEY in .env it is
  // the backup used when the main text provider hits a rate limit or quota; it is
  // only the main provider when nothing else is configured.
  omniroute: {
    name: 'OmniRoute',
    get baseURL() {
      return process.env.OMNIROUTE_BASE_URL || OMNIROUTE_DEFAULT_BASE_URL;
    },
    defaultModel: 'auto',
    models: ['auto'],
    envKey: 'OMNIROUTE_API_KEY',
    envModel: 'OMNIROUTE_MODEL',
    fallbackOnly: true,
  },
};

// Errors that mean "this provider is out of requests or credits right now",
// as opposed to a bad prompt or a broken key.
function isLimitError(error) {
  if (!error) return false;
  const status = error.status ?? error.code;
  if (status === 429 || status === 402) return true;
  return /rate.?limit|quota|resource.?exhausted|too many requests|insufficient.?(credit|balance|funds)/i
    .test(error.message || '');
}

class AITextService {
  constructor(credentials = {}) {
    this.logger = new Logger('AITextService');
    this.client = null;
    this.gemini = null;
    this.model = null;
    this.providerName = null;
    this.fallback = null;

    this._init(credentials);
  }

  _init(credentials) {
    this._initPrimary(credentials);

    const omniroute = PROVIDERS.omniroute;
    const omnirouteKey = process.env[omniroute.envKey];
    if (!omnirouteKey) return;

    const savedModel = credentials.aiProvider?.provider === 'omniroute' ? credentials.aiProvider.model : undefined;
    const model = process.env[omniroute.envModel] || savedModel;
    if (!this.isAvailable()) {
      // Nothing else configured: OmniRoute is the only text provider.
      return this._initOpenAICompatible(omniroute, omnirouteKey, model);
    }
    if (this.providerName === omniroute.name) return;

    this.fallback = {
      client: new OpenAI({ apiKey: omnirouteKey, baseURL: omniroute.baseURL }),
      gemini: null,
      model: model || omniroute.defaultModel,
      providerName: omniroute.name,
    };
    this.logger.info(`OmniRoute ready as backup when ${this.providerName} hits its limit (model: ${this.fallback.model})`);
  }

  _initPrimary(credentials) {
    const provider = credentials.aiProvider?.provider;
    const apiKey = credentials.aiProvider?.apiKey;
    const model = credentials.aiProvider?.model;

    if (provider && PROVIDERS[provider] && apiKey) {
      const preset = PROVIDERS[provider];
      const envModel = preset.envModel && process.env[preset.envModel];
      return this._initOpenAICompatible(preset, apiKey, envModel || model);
    }

    for (const [, preset] of Object.entries(PROVIDERS)) {
      const key = process.env[preset.envKey];
      if (key && !preset.fallbackOnly) {
        return this._initOpenAICompatible(preset, key);
      }
    }

    const geminiKey = credentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (geminiKey) {
      return this._initGemini(geminiKey, credentials.gemini?.model);
    }

    if (!process.env[PROVIDERS.omniroute.envKey]) {
      this.logger.warn('No AI text provider configured — text generation unavailable');
    }
  }

  _initOpenAICompatible(preset, apiKey, model) {
    this.client = new OpenAI({ apiKey, baseURL: preset.baseURL });
    this.model = model || preset.defaultModel;
    this.providerName = preset.name;
    this.logger.info(`${preset.name} initialized (model: ${this.model})`);
  }

  _initGemini(apiKey, model) {
    try {
      const { GoogleGenAI } = require('@google/genai');
      this.gemini = new GoogleGenAI({ apiKey });
      this.model = model || GEMINI_DEFAULT_MODEL;
      this.providerName = 'Google Gemini';
      this.logger.info(`Gemini initialized (model: ${this.model})`);
    } catch (error) {
      this.logger.error('Failed to initialize Gemini:', error.message);
    }
  }

  async generateText(rawPrompt, options = {}) {
    const prompt = options.skipChannelPolicy ? rawPrompt : applyTextPolicy(rawPrompt);
    try {
      return await this._generate(this, prompt, options);
    } catch (error) {
      if (!this.fallback || !isLimitError(error)) throw error;
      this.logger.warn(
        `${this.providerName} hit its limit (${error.message}); switching to ${this.fallback.providerName}`
      );
      return this._generate(this.fallback, prompt, { ...options, model: undefined });
    }
  }

  // target is this service (main provider) or this.fallback; both carry
  // client/gemini/model/providerName.
  async _generate(target, prompt, options) {
    const model = options.model || target.model;
    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature ?? 0.7;

    if (target.gemini) {
      const config = { maxOutputTokens: maxTokens };
      if (!/^gemini-3\.(?:[5-9]|\d{2,})-/.test(model)) config.temperature = temperature;
      const response = await target.gemini.models.generateContent({
        model,
        contents: prompt,
        config,
      });
      const text = response && response.text;
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error(
          `${target.providerName} returned an empty response. Check the API key and model quota — free-tier Gemini keys are rate-limited and can return empty output.`
        );
      }
      return text;
    }

    if (!target.client) {
      throw new Error('No AI text provider configured');
    }

    const params = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
    };

    try {
      // Newer OpenAI models (gpt-5.x and later) reject the legacy max_tokens
      // parameter with a 400 error and require max_completion_tokens instead.
      const response = await target.client.chat.completions.create({
        ...params,
        max_completion_tokens: maxTokens,
      });
      return this._extractContent(response, target.providerName);
    } catch (error) {
      // Older models and some providers reject max_completion_tokens with a 400;
      // retry the same request using the legacy max_tokens spelling.
      if (
        error &&
        error.status === 400 &&
        /max(_completion)?_tokens/i.test(error.message || '')
      ) {
        const response = await target.client.chat.completions.create({
          ...params,
          max_tokens: maxTokens,
        });
        return this._extractContent(response, target.providerName);
      }
      throw error;
    }
  }

  _extractContent(response, providerName = this.providerName) {
    const content =
      response &&
      response.choices &&
      response.choices[0] &&
      response.choices[0].message
        ? response.choices[0].message.content
        : null;

    if (typeof content !== 'string' || !content.trim()) {
      // A null/empty body used to surface as cryptic "Unexpected end of JSON input"
      // in the agents' JSON parsers. Report the real cause instead.
      throw new Error(
        `${providerName} returned an empty response. Check the API key and model quota.`
      );
    }
    return content;
  }

  isAvailable() {
    return !!(this.client || this.gemini);
  }
}

module.exports = { AITextService, PROVIDERS, OMNIROUTE_DEFAULT_BASE_URL, isLimitError, GEMINI_MODELS, GEMINI_DEFAULT_MODEL };
