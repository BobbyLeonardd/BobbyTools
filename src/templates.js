// BobbyTools Provider Templates v2
// Each template defines credential fields that accounts must fill in.
// URL placeholders {key} are replaced with account credential values at launch time.

export const PROVIDER_TEMPLATES = [
  // ═══════════════════════════════════
  // CLOUD PROVIDERS
  // ═══════════════════════════════════
  {
    name: 'OpenRouter',
    description: 'Unified API — 200+ models',
    category: 'cloud',
    baseUrlTemplate: 'https://openrouter.ai/api/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'Groq',
    description: 'Ultra-fast LPU inference',
    category: 'cloud',
    baseUrlTemplate: 'https://api.groq.com/openai/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'Cloudflare Workers AI',
    description: 'Serverless AI — needs Account ID',
    category: 'cloud',
    baseUrlTemplate: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
      { label: 'Account ID', key: 'accountId', secret: false, required: true },
    ],
  },
  {
    name: 'Together AI',
    description: 'Open-source model hosting',
    category: 'cloud',
    baseUrlTemplate: 'https://api.together.xyz/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'DeepSeek',
    description: 'Reasoning and coding models',
    category: 'cloud',
    baseUrlTemplate: 'https://api.deepseek.com',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'Fireworks AI',
    description: 'Fast inference and fine-tuning',
    category: 'cloud',
    baseUrlTemplate: 'https://api.fireworks.ai/inference/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'Cerebras',
    description: 'Wafer-scale inference',
    category: 'cloud',
    baseUrlTemplate: 'https://api.cerebras.ai/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'SambaNova',
    description: 'Enterprise AI inference',
    category: 'cloud',
    baseUrlTemplate: 'https://api.sambanova.ai/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'Novita AI',
    description: 'GPU cloud inference',
    category: 'cloud',
    baseUrlTemplate: 'https://api.novita.ai/v3/openai',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'Chutes AI',
    description: 'Serverless AI endpoints',
    category: 'cloud',
    baseUrlTemplate: 'https://api.chutes.ai/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'GitHub Models',
    description: 'AI models via GitHub PAT',
    category: 'cloud',
    baseUrlTemplate: 'https://models.inference.ai.azure.com',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'GitHub Token', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'Google Gemini (OpenAI compat)',
    description: 'Gemini via OpenAI-compatible endpoint',
    category: 'cloud',
    baseUrlTemplate: 'https://generativelanguage.googleapis.com/v1beta/openai',
    modelsEndpoint: null,
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'xAI (Grok)',
    description: 'Grok models from xAI',
    category: 'cloud',
    baseUrlTemplate: 'https://api.x.ai/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'Mistral AI',
    description: 'European AI models',
    category: 'cloud',
    baseUrlTemplate: 'https://api.mistral.ai/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'Genfity',
    description: 'AI gateway & models',
    category: 'cloud',
    baseUrlTemplate: 'https://ai.genfity.com/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'HuggingFace Inference',
    description: 'HF Inference API',
    category: 'cloud',
    baseUrlTemplate: 'https://api-inference.huggingface.co/v1',
    modelsEndpoint: null,
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'HF Token', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'OpenAI',
    description: 'Official OpenAI API',
    category: 'cloud',
    baseUrlTemplate: 'https://api.openai.com/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
      { label: 'Organization ID', key: 'orgId', envVar: 'OPENAI_ORG_ID', secret: false, required: false },
    ],
  },
  {
    name: 'Azure OpenAI',
    description: 'Azure-hosted OpenAI — needs resource name',
    category: 'cloud',
    baseUrlTemplate: 'https://{resourceName}.openai.azure.com/openai',
    modelsEndpoint: null,
    baseUrlEnvVar: 'AZURE_OPENAI_ENDPOINT',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'AZURE_OPENAI_API_KEY', secret: true, required: true },
      { label: 'Resource Name', key: 'resourceName', secret: false, required: true },
      { label: 'API Version', key: 'apiVersion', envVar: 'OPENAI_API_VERSION', secret: false, required: false, default: '2024-10-21' },
    ],
  },
  {
    name: 'Deepinfra',
    description: 'Low-cost model inference',
    category: 'cloud',
    baseUrlTemplate: 'https://api.deepinfra.com/v1/openai',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'Perplexity',
    description: 'Search-augmented AI',
    category: 'cloud',
    baseUrlTemplate: 'https://api.perplexity.ai',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'Lepton AI',
    description: 'AI cloud platform',
    category: 'cloud',
    baseUrlTemplate: 'https://api.lepton.ai/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'Cohere (OpenAI compat)',
    description: 'Enterprise NLP models',
    category: 'cloud',
    baseUrlTemplate: 'https://api.cohere.com/compatibility/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'Anthropic',
    description: 'Official Claude API',
    category: 'cloud',
    baseUrlTemplate: 'https://api.anthropic.com',
    modelsEndpoint: null,
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'ANTHROPIC_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'SiliconFlow',
    description: 'High performance AI platform',
    category: 'cloud',
    baseUrlTemplate: 'https://api.siliconflow.cn/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },
  {
    name: 'Upstage',
    description: 'Solar LLM API',
    category: 'cloud',
    baseUrlTemplate: 'https://api.upstage.ai/v1/solar',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: true, required: true },
    ],
  },

  // ═══════════════════════════════════
  // LOCAL PROVIDERS / NATIVE CLIs
  // ═══════════════════════════════════
  {
    name: 'Native Antigravity CLI (agy)',
    description: 'Direct launch agy (uses your native Google AI Pro config)',
    category: 'local',
    baseUrlTemplate: 'native',
    modelsEndpoint: null,
    baseUrlEnvVar: 'IGNORE',
    defaultCli: 'agy',
    skipModelSelection: true,
    credentials: [], 
  },
  {
    name: 'Native Codex CLI (codex)',
    description: 'Direct launch codex (uses your native Codex config)',
    category: 'local',
    baseUrlTemplate: 'native',
    modelsEndpoint: null,
    baseUrlEnvVar: 'IGNORE',
    defaultCli: 'codex',
    skipModelSelection: true,
    credentials: [], 
  },
  {
    name: 'Ollama',
    description: 'Local LLM server',
    category: 'local',
    baseUrlTemplate: 'http://localhost:11434/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: false, required: false, default: 'ollama' },
    ],
  },
  {
    name: 'LM Studio',
    description: 'Local model runner with GUI',
    category: 'local',
    baseUrlTemplate: 'http://localhost:1234/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: false, required: false, default: 'lm-studio' },
    ],
  },
  {
    name: 'LocalAI',
    description: 'Self-hosted OpenAI-compatible server',
    category: 'local',
    baseUrlTemplate: 'http://localhost:8080/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: false, required: false, default: 'local' },
    ],
  },
  {
    name: 'vLLM',
    description: 'High-throughput LLM serving',
    category: 'local',
    baseUrlTemplate: 'http://localhost:8000/v1',
    modelsEndpoint: '/models',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    credentials: [
      { label: 'API Key', key: 'apiKey', envVar: 'OPENAI_API_KEY', secret: false, required: false, default: 'vllm' },
    ],
  },
];
