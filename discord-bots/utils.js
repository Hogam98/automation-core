const config = require("./config.js");

function state(context, prefix, key, value = null) {
  return value !== null
    ? context.state.set(prefix, key, value)
    : context.state.get(prefix, key);
}

function getMessageTimestampMs(message) {
  const parsed = message?.timestamp ? new Date(message.timestamp).getTime() : NaN;
  return !Number.isNaN(parsed)
    ? parsed
    : Number(BigInt(message.id) >> BigInt(22)) + 1420070400000;
}

function getParisTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  const hour = Number(parts.find(p => p.type === "hour").value) % 24;
  const minute = Number(parts.find(p => p.type === "minute").value);
  return { hour, minute, totalMinutes: hour * 60 + minute };
}

function isWithinActiveHours() {
  const { hour } = getParisTimeParts();
  return hour >= config.ACTIVE_START_HOUR && hour < config.ACTIVE_END_HOUR;
}

function isPersonaAvailableNow(persona) {
  if (!Array.isArray(persona?.parisSlots) || persona.parisSlots.length === 0) {
    return true;
  }
  const { totalMinutes } = getParisTimeParts();
  return persona.parisSlots.some(slot => {
    const [startStr, endStr] = slot.split("-");
    const [sh, sm] = startStr.split(":").map(Number);
    const [eh, em] = endStr.split(":").map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    return start <= end
      ? totalMinutes >= start && totalMinutes < end
      : totalMinutes >= start || totalMinutes < end;
  });
}

function shuffleArray(items) {
  return [...items].sort(() => Math.random() - 0.5);
}

function formatFrenchList(items) {
  return items?.length ? new Intl.ListFormat("fr", { type: "conjunction" }).format(items) : "";
}

function getMessageAuthorName(message) {
  const author = message?.author;
  if (!author) {
    return "";
  }
  const rawName = message.webhook_id
    ? (author.username || author.global_name)
    : (author.global_name || author.username);
  return (rawName || "").trim();
}

function isBotOrWebhookMessage(message) {
  return !message?.author || Boolean(message.webhook_id || message.author.bot);
}

function isPersonaMessage(message, persona) {
  return isBotOrWebhookMessage(message)
    && getMessageAuthorName(message).toLowerCase() === persona.name.toLowerCase();
}

function findLatestHumanAuthor(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isBotOrWebhookMessage(msg) && msg?.author?.id) {
      return {
        id: String(msg.author.id),
        name: getMessageAuthorName(msg) || "User"
      };
    }
  }
  return null;
}

function getMemoryPrefix(personaName) {
  return `MEM_${String(personaName || "").trim().toUpperCase()}`;
}

function getUserMemory(context, personaName, userId) {
  const raw = state(context, getMemoryPrefix(personaName), String(userId));
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.filter(item => typeof item === "string" && item.trim());
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(item => typeof item === "string" && item.trim())
      : [];
  } catch {
    return [];
  }
}

function saveUserMemory(context, personaName, userId, rawNote) {
  const words = String(rawNote || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, config.MAX_MEMORY_WORDS);

  const note = words.join(" ");
  if (!note) {
    return;
  }

  const existing = getUserMemory(context, personaName, userId);
  const normalizedNew = note.toLowerCase();
  if (existing.some(item => item.toLowerCase() === normalizedNew)) {
    return;
  }

  const updated = [...existing, note].slice(-config.MAX_MEMORY_NOTES_PER_USER);
  state(context, getMemoryPrefix(personaName), String(userId), updated);
}

function buildMemoryContext(context, personaName, messages) {
  const seenUsers = new Map();
  for (const msg of messages) {
    if (!isBotOrWebhookMessage(msg) && msg?.author?.id) {
      seenUsers.set(String(msg.author.id), getMessageAuthorName(msg) || "User");
    }
  }

  const lines = [];
  for (const [userId, userName] of seenUsers.entries()) {
    const notes = getUserMemory(context, personaName, userId);
    if (notes.length > 0) {
      lines.push(`${userName} : ${notes.join(" ; ")}`);
    }
  }
  return lines.join("\n");
}

function formatMessageContent(message) {
  let rawText = (message.content || "").trim();
  if (rawText && Array.isArray(message.mentions)) {
    for (const user of message.mentions) {
      const displayName = user.global_name || user.username;
      rawText = rawText.replace(new RegExp(`<@!?${user.id}>`, "g"), `@${displayName}`);
    }
  }

  const extras = [];
  if (message.stickers?.length) {
    extras.push(`[Sticker ${message.stickers[0].name}]`);
  }
  if (message.attachments?.length) {
    extras.push(`[File ${message.attachments[0].filename || "attachment"}]`);
  }
  if (message.embeds?.length && !rawText) {
    const summary = message.embeds[0].title || message.embeds[0].description;
    extras.push(summary ? `[Embed ${summary.slice(0, 120)}]` : "[Shared link]");
  }

  return [rawText, ...extras].filter(Boolean).join(" ") || "[Empty message]";
}

function formatRelativeAge(timestampMs, nowMs) {
  const diffMinutes = Math.max(0, Math.floor((nowMs - timestampMs) / 60000));
  if (diffMinutes < 1) return "à l'instant";
  if (diffMinutes < 60) return `il y a ${diffMinutes} min`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `il y a ${diffHours} h`;
  return `il y a ${Math.floor(diffHours / 24)} j`;
}

function formatChatHistory(messages, activePersona, lastReadId = null) {
  const nowMs = Date.now();
  return messages.map(message => {
    const unreadTag = lastReadId && BigInt(message.id) > BigInt(lastReadId) ? "[NEW] " : "";
    const ageTag = `[${formatRelativeAge(getMessageTimestampMs(message), nowMs)}] `;
    const authorName = isPersonaMessage(message, activePersona)
      ? `${activePersona.name} [SELF]`
      : (getMessageAuthorName(message) || "User");

    let replyContext = "";
    if (message.referenced_message) {
      const refAuthor = isPersonaMessage(message.referenced_message, activePersona)
        ? activePersona.name
        : (getMessageAuthorName(message.referenced_message) || "user");
      const refSnippet = (message.referenced_message.content || "").trim().slice(0, 60);
      replyContext = refSnippet ? ` (↪ ${refAuthor} "${refSnippet}")` : ` (↪ ${refAuthor})`;
    }

    return `${unreadTag}${ageTag}[msg ${message.id}] ${authorName}${replyContext} | ${formatMessageContent(message)}`;
  }).join("\n");
}

function cleanBotReply(text) {
  return String(text || "").trim();
}

module.exports = {
  state,
  getMessageTimestampMs,
  isWithinActiveHours,
  isPersonaAvailableNow,
  shuffleArray,
  formatFrenchList,
  getMessageAuthorName,
  isBotOrWebhookMessage,
  isPersonaMessage,
  findLatestHumanAuthor,
  saveUserMemory,
  buildMemoryContext,
  formatChatHistory,
  cleanBotReply
};
