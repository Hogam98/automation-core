const config = require("./config.js");

function formatWeightedList(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "";
  }
  return items
    .map(item => Array.isArray(item) ? `${item[0]} (${item[1]}%)` : String(item))
    .join(", ");
}

function formatWeightedValue(entry) {
  if (!entry) {
    return "";
  }
  return Array.isArray(entry) ? `${entry[0]} (${entry[1]}%)` : String(entry);
}

function formatRelations(relations) {
  if (!relations || typeof relations !== "object") {
    return "";
  }
  return Object.entries(relations)
    .map(([name, weight]) => `${name} (${weight}%)`)
    .join(", ");
}

function formatPersonaProfile(persona) {
  const fields = [
    ["Identité", persona.age && persona.gender && persona.country && `${persona.name}, ${persona.age} ans, ${persona.gender.toLowerCase()}, vit en ${persona.country}`],
    ["Situation", formatWeightedValue(persona.situation)],
    ["Caractère", formatWeightedList(persona.traits)],
    ["Passions", formatWeightedList(persona.passions)],
    ["Aime", formatWeightedList(persona.likes)],
    ["Déteste", formatWeightedList(persona.dislikes)],
    ["Jeux", formatWeightedList(persona.games)],
    ["Affinités avec les autres membres", formatRelations(persona.relations)],
    ["Entourage", persona.family],
    ["Animal", persona.pet]
  ];

  return fields
    .filter(([, value]) => Boolean(value))
    .map(([label, value]) => `${label} : ${value}.`)
    .join("\n");
}

function buildSystemPrompt(persona, otherNames, allowBotInteraction, memoryContext = "", isChannelEmpty = false) {
  const targetLanguageName = config.LANGUAGE_LABELS[persona.language];

  const contextParagraph = allowBotInteraction
    ? `Tu participes à un salon Discord multilingue avec ${otherNames ? `${otherNames} et ` : ""}les membres du serveur.`
    : `Tu participes à un salon Discord avec les membres humains du serveur${otherNames ? `, sans jamais t'adresser aux autres personnages (${otherNames})` : ""}.`;

  const profileRules = [
    `Tu es ${persona.name}. Tu écris uniquement en ${targetLanguageName} et tu comprends le français, l'anglais et l'espagnol.`,
    "Les pourcentages de ta fiche indiquent le poids de chaque trait, goût, aversion ou affinité dans ta manière naturelle de t'exprimer et de réagir.",
    isChannelEmpty
      ? "Lance un premier sujet de discussion naturel lié à tes données de profil. Ne renvoie jamais une chaîne vide dans \"text\"."
      : "N'interviens que si ton message apporte une réponse, une information ou un point de vue réellement pertinent. Si le sujet ne te correspond pas, si une réponse complète a déjà été donnée dans le salon ou si tu n'as rien d'utile à ajouter, renvoie une chaîne vide dans \"text\"."
  ].join("\n");

  const blocks = [
    profileRules,
    formatPersonaProfile(persona),
    contextParagraph
  ];

  if (memoryContext) {
    blocks.push(`Notes mémorisées sur les membres humains présents :\n${memoryContext}`);
  }

  return blocks.filter(Boolean).join("\n\n");
}

function buildTurnDirective(allowBotInteraction, shouldPayCloseAttention, shouldChangeTopic = false, targetHuman = null, isChannelEmpty = false) {
  let baseDirective;

  if (isChannelEmpty) {
    baseDirective = "Le salon est vide. Lance un premier sujet de discussion naturel lié à tes données de profil, sans renvoyer une chaîne vide.";
  } else if (allowBotInteraction) {
    baseDirective = shouldChangeTopic
      ? "La discussion précédente est close après une pause. Lance un nouveau sujet lié à tes données de profil."
      : "Continue l'échange à partir des messages du salon.";
  } else {
    baseDirective = shouldPayCloseAttention
      ? "Lis l'échange récent en portant attention aux messages marqués [NEW]."
      : "Lis l'échange récent et ne réponds que si ton intervention a un réel intérêt.";
  }

  if (!targetHuman) {
    return baseDirective;
  }

  return `${baseDirective}\nSi les messages récents contiennent un fait nouveau et durable concernant ${targetHuman.name}, résume-le en ${config.MAX_MEMORY_WORDS} mots maximum dans "memory", sinon laisse "memory" vide.`;
}

async function queryGeminiReply(context, { systemPrompt, chatHistory, activePersona, turnDirective = "" }) {
  const geminiApiKey = context.secrets.GEMINI_API_KEY;
  if (!geminiApiKey) {
    throw new Error('Missing required secret "GEMINI_API_KEY".');
  }

  const targetLanguageName = config.LANGUAGE_LABELS[activePersona.language];
  const userInstruction = [turnDirective, chatHistory].filter(Boolean).join("\n\n");

  const payload = {
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: [
      {
        role: "user",
        parts: [{ text: userInstruction }]
      }
    ],
    generationConfig: {
      temperature: config.GEMINI_TEMPERATURE,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          text: {
            type: "STRING",
            description: `Message en ${targetLanguageName}, ou chaîne vide si aucune intervention n'est pertinente.`
          },
          memory: {
            type: "STRING",
            description: `Fait notable sur l'interlocuteur humain en ${config.MAX_MEMORY_WORDS} mots maximum, ou chaîne vide.`
          }
        },
        required: ["text", "memory"]
      }
    }
  };

  const data = await context.gateway.postJson(
    `/gemini/v1beta/models/${config.GEMINI_MODEL}:generateContent`,
    payload,
    { "x-goog-api-key": geminiApiKey }
  );

  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  try {
    return JSON.parse(rawText);
  } catch {
    console.warn(`[DiscordBots] [Gemini] Failed to parse JSON response (${rawText}).`);
    return { text: "", memory: "" };
  }
}

async function fetchDiscordMessages(context, channelId) {
  const botToken = context.secrets.DISCORD_BOT_TOKEN;
  if (!botToken) {
    throw new Error('Missing required secret "DISCORD_BOT_TOKEN".');
  }

  return context.gateway.getJson(
    `/discord/api/v10/channels/${channelId}/messages?limit=${config.MESSAGE_LIMIT}`,
    {
      "Authorization": `Bot ${botToken}`,
      "User-Agent": "DiscordBot (https://discord.com, 1.0)"
    }
  );
}

async function sendWebhookMessage(context, channelConfig, persona, content) {
  const webhookId = context.secrets[channelConfig.webhookIdSecret];
  const webhookToken = context.secrets[channelConfig.webhookTokenSecret];
  if (!webhookId || !webhookToken) {
    throw new Error(`Missing required webhook secrets ("${channelConfig.webhookIdSecret}", "${channelConfig.webhookTokenSecret}") for channel "${channelConfig.name}".`);
  }

  const payload = {
    username: persona.name,
    content: content.slice(0, 2000)
  };
  if (persona?.avatarUrl?.trim()) {
    payload.avatar_url = persona.avatarUrl.trim();
  }

  await context.gateway.postJson(
    `/discord/api/v10/webhooks/${webhookId}/${webhookToken}`,
    payload
  );
}

module.exports = {
  buildSystemPrompt,
  buildTurnDirective,
  queryGeminiReply,
  fetchDiscordMessages,
  sendWebhookMessage
};
