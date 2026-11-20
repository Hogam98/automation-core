const config = require("./config.js");
const utils = require("./utils.js");

const STOPWORDS = new Set([
  "avec", "dans", "pour", "plus", "tout", "tous", "vous", "nous", "elles", "mais",
  "donc", "quoi", "quel", "quelle", "quels", "quelles", "comme", "cette", "faire",
  "avoir", "être", "suis", "sont", "salut", "bonjour", "coucou", "merci", "bien",
  "with", "from", "that", "this", "have", "what", "when", "where", "which", "your",
  "they", "them", "been", "just", "like", "good", "hello", "thanks", "about", "into",
  "para", "como", "pero", "todo", "esta", "este", "hola", "gracias", "tengo", "sobre"
]);

function getPersonasForLanguage(lang, personas) {
  if (lang === "Multilingual") {
    return personas;
  }
  const matched = personas.filter(p => p.language === lang);
  return matched.length > 0 ? matched : personas;
}

function isDirectAddressed(content, personaName) {
  const cleaned = String(content || "").trim();
  if (!cleaned) {
    return false;
  }
  const escaped = personaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(cleaned);
}

function normalizeSearchText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function extractKeywords(label) {
  return normalizeSearchText(label)
    .split(/[^a-z0-9]+/)
    .filter(word => word.length >= 4 && !STOPWORDS.has(word));
}

function computeTopicScore(persona, normalizedContent) {
  let score = 0;
  const entries = [
    ...(Array.isArray(persona.games) ? persona.games : []),
    ...(Array.isArray(persona.passions) ? persona.passions : [])
  ];

  for (const entry of entries) {
    const [label, weight] = Array.isArray(entry) ? entry : [entry, 50];
    if (weight <= config.HIGH_INTEREST_THRESHOLD) {
      continue;
    }
    const normalizedLabel = normalizeSearchText(label);
    if (normalizedLabel && normalizedContent.includes(normalizedLabel)) {
      score += weight * 2;
      continue;
    }
    const keywords = extractKeywords(label);
    if (keywords.some(kw => normalizedContent.includes(kw))) {
      score += weight;
    }
  }
  return score;
}

function findTopicMatchedPersonas(messages, candidatePersonas) {
  const combined = normalizeSearchText(messages.map(m => m.content || "").join(" "));
  if (!combined) {
    return [];
  }

  return candidatePersonas
    .map(persona => ({ persona, score: computeTopicScore(persona, combined) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(item => item.persona);
}

function getRecentBotSpeakers(messages, maxCount, allPersonas) {
  const speakers = [];
  for (let i = messages.length - 1; i >= 0 && speakers.length < maxCount; i--) {
    if (!utils.isBotOrWebhookMessage(messages[i])) {
      continue;
    }
    const authorName = utils.getMessageAuthorName(messages[i]).toLowerCase();
    const matched = allPersonas.find(p => p.name.toLowerCase() === authorName);
    const previous = speakers[speakers.length - 1];
    if (matched && previous?.toLowerCase() !== matched.name.toLowerCase()) {
      speakers.push(matched.name);
    }
  }
  return speakers;
}

function pickBalancedPersona(context, channelId, messages, candidatePersonas, allPersonas) {
  const availableNow = candidatePersonas.filter(p => utils.isPersonaAvailableNow(p));
  const activeCandidates = availableNow.length > 0 ? availableNow : candidatePersonas;

  const recentSpeakers = getRecentBotSpeakers(messages, 4, allPersonas);
  const lastSpeaker = utils.state(context, "LAST_PERSONA", channelId) || recentSpeakers[0] || "";
  const excludeLimit = Math.min(2, activeCandidates.length - 1);
  const excluded = new Set(recentSpeakers.slice(0, excludeLimit).map(name => name.toLowerCase()));
  if (lastSpeaker) {
    excluded.add(lastSpeaker.toLowerCase());
  }

  const fresh = activeCandidates.filter(p => !excluded.has(p.name.toLowerCase()));
  const fallback = activeCandidates.filter(p => p.name.toLowerCase() !== lastSpeaker.toLowerCase());
  const pool = fresh.length > 0 ? fresh : (fallback.length > 0 ? fallback : activeCandidates);
  return pool[Math.floor(Math.random() * pool.length)];
}

function findDirectSolicitation(messages, candidatePersonas, maxAgeMinutes = config.DIRECT_MENTION_MAX_AGE_MINUTES, excludedNameLower = "") {
  const cutoffMs = maxAgeMinutes > 0 ? Date.now() - maxAgeMinutes * 60000 : 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (cutoffMs && utils.getMessageTimestampMs(msg) < cutoffMs) {
      continue;
    }
    for (const persona of utils.shuffleArray(candidatePersonas)) {
      if (excludedNameLower && persona.name.toLowerCase() === excludedNameLower) {
        continue;
      }
      if (utils.isPersonaMessage(msg.referenced_message, persona) || isDirectAddressed(msg.content, persona.name)) {
        return persona;
      }
    }
  }
  return null;
}

function findRecentThreadPersona(contextMessages, candidatePersonas) {
  const cutoffMs = Date.now() - config.ACTIVE_CONVERSATION_WINDOW_MINUTES * 60000;
  for (const msg of contextMessages.slice(-8).reverse()) {
    if (utils.getMessageTimestampMs(msg) < cutoffMs) {
      continue;
    }
    const matched = candidatePersonas.find(p => utils.isPersonaMessage(msg, p));
    if (matched) {
      return matched;
    }
  }
  return null;
}

function getLastBotTurnMessages(messages) {
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || !utils.isBotOrWebhookMessage(lastMsg)) {
    return [];
  }
  const lastAuthor = utils.getMessageAuthorName(lastMsg).toLowerCase();
  const turn = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!utils.isBotOrWebhookMessage(messages[i]) || utils.getMessageAuthorName(messages[i]).toLowerCase() !== lastAuthor) {
      break;
    }
    turn.unshift(messages[i]);
  }
  return turn;
}

function selectPersona(context, channelId, humanUnreadMessages, contextMessages, candidatePersonas, allPersonas, allowBotInteraction) {
  if (humanUnreadMessages.length > 0) {
    const addressed = findDirectSolicitation(
      humanUnreadMessages,
      candidatePersonas,
      config.DIRECT_MENTION_MAX_AGE_MINUTES
    );
    if (addressed) {
      return { persona: addressed, isSolicited: true, inActiveThread: true, hasTopicMatch: true };
    }

    const topicMatched = findTopicMatchedPersonas(humanUnreadMessages, candidatePersonas);
    if (topicMatched.length > 0) {
      return {
        persona: pickBalancedPersona(context, channelId, contextMessages, topicMatched, allPersonas),
        isSolicited: false,
        inActiveThread: false,
        hasTopicMatch: true
      };
    }

    if (allowBotInteraction) {
      return {
        persona: pickBalancedPersona(context, channelId, contextMessages, candidatePersonas, allPersonas),
        isSolicited: true,
        inActiveThread: true,
        hasTopicMatch: false
      };
    }

    const threadPersona = findRecentThreadPersona(contextMessages, candidatePersonas);
    if (threadPersona) {
      return { persona: threadPersona, isSolicited: false, inActiveThread: true, hasTopicMatch: false };
    }
  }

  if (allowBotInteraction && humanUnreadMessages.length === 0) {
    const lastBotTurn = getLastBotTurnMessages(contextMessages);
    if (lastBotTurn.length > 0) {
      const botAuthor = utils.getMessageAuthorName(lastBotTurn[0]).toLowerCase();
      const secondLastSpeaker = getRecentBotSpeakers(contextMessages, 4, allPersonas)[1] || "";
      const addressedBot = findDirectSolicitation(lastBotTurn, candidatePersonas, 0, botAuthor);
      if (addressedBot && secondLastSpeaker.toLowerCase() !== addressedBot.name.toLowerCase()) {
        return { persona: addressedBot, isSolicited: true, inActiveThread: true, hasTopicMatch: false };
      }
    }
  }

  return {
    persona: pickBalancedPersona(context, channelId, contextMessages, candidatePersonas, allPersonas),
    isSolicited: false,
    inActiveThread: false,
    hasTopicMatch: false
  };
}

function pickRelayPersona(context, channelId, humanUnreadMessages, contextMessages, relayCandidates, allPersonas) {
  if (relayCandidates.length === 0) {
    return null;
  }
  const topicMatched = findTopicMatchedPersonas(humanUnreadMessages, relayCandidates);
  const pool = topicMatched.length > 0 ? topicMatched : relayCandidates;
  return pickBalancedPersona(context, channelId, contextMessages, pool, allPersonas);
}

module.exports = {
  getPersonasForLanguage,
  findDirectSolicitation,
  pickBalancedPersona,
  selectPersona,
  pickRelayPersona
};
