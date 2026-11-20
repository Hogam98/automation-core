const config = require("./config.js");
const utils = require("./utils.js");
const personas = require("./personas.js");
const api = require("./api.js");

function resolvePersonas(optionsPersonas) {
  if (!Array.isArray(optionsPersonas) || optionsPersonas.length === 0) {
    return config.DEFAULT_PERSONAS;
  }

  return optionsPersonas
    .filter(p => p?.name?.trim())
    .map(p => {
      const base = config.DEFAULT_PERSONAS.find(
        d => d.name.toLowerCase() === p.name.trim().toLowerCase()
      );
      return base
        ? { ...base, ...p, avatarUrl: p.avatarUrl?.trim() || base.avatarUrl || "" }
        : p;
    });
}

async function run(context, options = {}) {
  const channels = Array.isArray(options.channels) ? options.channels : [];
  const allowBotInteraction = Boolean(options.allowBotInteraction);
  const allPersonas = resolvePersonas(options.personas);

  if (allPersonas.length === 0) {
    console.log("[DiscordBots] Execution skipped (no valid personas configured).");
    return;
  }

  for (let i = 0; i < channels.length; i++) {
    try {
      await processChannel(context, channels[i], allPersonas, allowBotInteraction);
    } catch (e) {
      console.warn(`[DiscordBots] [Channel ${channels[i].name}] Processing failed (${e.message}).`);
    }
    if (i < channels.length - 1) {
      await context.sleep(config.POLL_DELAY_MS);
    }
  }
}

async function processChannel(context, channelConfig, allPersonas, allowBotInteraction) {
  const withinActiveHours = utils.isWithinActiveHours();

  if (allowBotInteraction && !withinActiveHours) {
    const start = String(config.ACTIVE_START_HOUR).padStart(2, "0");
    const end = String(config.ACTIVE_END_HOUR).padStart(2, "0");
    console.log(`[DiscordBots] [Channel ${channelConfig.name}] Execution skipped (outside active hours ${start}h to ${end}h Europe/Paris).`);
    return;
  }

  const channelId = context.secrets[channelConfig.channelIdSecret];
  if (!channelId) {
    throw new Error(`Missing required secret "${channelConfig.channelIdSecret}" for channel "${channelConfig.name}".`);
  }

  const lastReadId = utils.state(context, "LAST_MSG", channelId);
  const rawMessages = await api.fetchDiscordMessages(context, channelId);
  const messages = Array.isArray(rawMessages) ? [...rawMessages].reverse() : [];
  const newestMessage = messages[messages.length - 1] || null;

  if (!allowBotInteraction) {
    if (!newestMessage) {
      if (withinActiveHours) {
        await tryReviveChannel(context, channelConfig, channelId, [], null, allPersonas);
      }
      return;
    }
    if (!lastReadId) {
      utils.state(context, "LAST_MSG", channelId, newestMessage.id);
      console.log(`[DiscordBots] [Channel ${channelConfig.name}] Initialized state at message ID ${newestMessage.id}.`);
      return;
    }
  }

  const unreadMessages = lastReadId
    ? messages.filter(m => BigInt(m.id) > BigInt(lastReadId))
    : messages;
  const newestMessageId = (unreadMessages[unreadMessages.length - 1] || newestMessage)?.id || null;
  const humanUnreadMessages = unreadMessages.filter(m => !utils.isBotOrWebhookMessage(m));
  const markAllRead = () => newestMessageId && utils.state(context, "LAST_MSG", channelId, newestMessageId);

  if (!allowBotInteraction) {
    if (unreadMessages.length === 0) {
      if (withinActiveHours) {
        await tryReviveChannel(context, channelConfig, channelId, messages, newestMessage, allPersonas);
      }
      return;
    }
    if (humanUnreadMessages.length === 0) {
      markAllRead();
      return;
    }
  }

  let relevantMessages = messages;
  let shouldChangeTopic = false;

  if (allowBotInteraction) {
    const flow = evaluateSandboxFlow(messages, humanUnreadMessages);
    if (flow.shouldSkip) {
      console.log(`[DiscordBots] [Channel ${channelConfig.name}] Pause active (${config.BOT_PAUSE_MINUTES} min cooldown after ${config.MAX_BOT_BURST} bot messages).`);
      return;
    }
    relevantMessages = flow.relevantMessages;
    shouldChangeTopic = flow.shouldChangeTopic;
  }

  const candidatePersonas = personas.getPersonasForLanguage(channelConfig.language, allPersonas);
  if (candidatePersonas.length === 0) {
    markAllRead();
    console.log(`[DiscordBots] [Channel ${channelConfig.name}] Processing skipped (no matching persona available for language "${channelConfig.language}").`);
    return;
  }

  if (!allowBotInteraction && !withinActiveHours) {
    const directPersona = personas.findDirectSolicitation(
      humanUnreadMessages,
      candidatePersonas,
      config.DIRECT_MENTION_MAX_AGE_MINUTES
    );
    if (!directPersona) {
      markAllRead();
      console.log(`[DiscordBots] [Channel ${channelConfig.name}] Outside active hours without recent direct solicitation (marked messages as read).`);
      return;
    }

    await generateAndSend(context, {
      channelConfig,
      channelId,
      activePersona: directPersona,
      allPersonas,
      relevantMessages,
      lastReadId,
      allowBotInteraction: false,
      turnDirective: api.buildTurnDirective(false, true, false, utils.findLatestHumanAuthor(relevantMessages)),
      onBeforeSend: markAllRead
    });
    return;
  }

  const selection = shouldChangeTopic
    ? {
        persona: personas.pickBalancedPersona(context, channelId, messages, candidatePersonas, allPersonas),
        isSolicited: false,
        inActiveThread: false,
        hasTopicMatch: false
      }
    : personas.selectPersona(
        context,
        channelId,
        humanUnreadMessages,
        relevantMessages,
        candidatePersonas,
        allPersonas,
        allowBotInteraction
      );

  if (!allowBotInteraction && !selection.isSolicited && !selection.inActiveThread && !selection.hasTopicMatch) {
    const elapsedMs = Date.now() - Number(utils.state(context, "LAST_BOT_TIME", channelId) || 0);
    const cooldownMs = config.SPONTANEOUS_COOLDOWN_MINUTES * 60000;
    if (elapsedMs < cooldownMs || Math.random() * 100 > config.SPONTANEOUS_REPLY_CHANCE) {
      markAllRead();
      console.log(`[DiscordBots] [Channel ${channelConfig.name}] Reply skipped (no direct relevance or cooldown active).`);
      return;
    }
  }

  const targetHuman = utils.findLatestHumanAuthor(relevantMessages);
  const turnDirective = api.buildTurnDirective(
    allowBotInteraction,
    selection.isSolicited || selection.inActiveThread || selection.hasTopicMatch,
    shouldChangeTopic,
    targetHuman,
    relevantMessages.length === 0
  );

  const sent = await generateAndSend(context, {
    channelConfig,
    channelId,
    activePersona: selection.persona,
    allPersonas,
    relevantMessages,
    lastReadId,
    allowBotInteraction,
    turnDirective,
    onBeforeSend: markAllRead
  });

  if (!sent && candidatePersonas.length > 1) {
    const relayCandidates = candidatePersonas.filter(
      p => p.name.toLowerCase() !== selection.persona.name.toLowerCase()
    );
    const relayPersona = personas.pickRelayPersona(
      context,
      channelId,
      humanUnreadMessages,
      relevantMessages,
      relayCandidates,
      allPersonas
    );

    if (relayPersona) {
      await generateAndSend(context, {
        channelConfig,
        channelId,
        activePersona: relayPersona,
        allPersonas,
        relevantMessages,
        lastReadId,
        allowBotInteraction,
        turnDirective
      });
    }
  }
}

async function tryReviveChannel(context, channelConfig, channelId, messages, lastMessage, allPersonas) {
  if (!channelConfig.reviveEnabled) {
    return;
  }

  if (lastMessage) {
    const isBot = utils.isBotOrWebhookMessage(lastMessage);
    const inactiveMs = Date.now() - utils.getMessageTimestampMs(lastMessage);
    if (isBot || inactiveMs < config.INACTIVITY_REVIVE_HOURS * 3600000) {
      return;
    }
  }

  const lastReviveTime = Number(utils.state(context, "LAST_REVIVE_TIME", channelId) || 0);
  if (Date.now() - lastReviveTime < config.REVIVE_COOLDOWN_HOURS * 3600000) {
    return;
  }

  const candidatePersonas = personas.getPersonasForLanguage(channelConfig.language, allPersonas);
  if (candidatePersonas.length === 0) {
    return;
  }

  const activePersona = personas.pickBalancedPersona(
    context,
    channelId,
    messages,
    candidatePersonas,
    allPersonas
  );

  const sent = await generateAndSend(context, {
    channelConfig,
    channelId,
    activePersona,
    allPersonas,
    turnDirective: api.buildTurnDirective(false, false, false, null, true)
  });

  if (sent) {
    utils.state(context, "LAST_REVIVE_TIME", channelId, Date.now());
  }
}

async function generateAndSend(context, {
  channelConfig,
  channelId,
  activePersona,
  allPersonas,
  relevantMessages = [],
  lastReadId = null,
  allowBotInteraction = false,
  turnDirective = "",
  onBeforeSend = null
}) {
  const allChannelPersonas = personas.getPersonasForLanguage(channelConfig.language, allPersonas);
  const otherNames = utils.formatFrenchList(
    allChannelPersonas.filter(p => p.name !== activePersona.name).map(p => p.name)
  );
  const chatHistory = relevantMessages.length > 0
    ? utils.formatChatHistory(relevantMessages, activePersona, lastReadId)
    : "Aucun message récent n'a été publié dans ce salon.";

  const memoryContext = utils.buildMemoryContext(context, activePersona.name, relevantMessages);
  const systemPrompt = api.buildSystemPrompt(
    activePersona,
    otherNames,
    allowBotInteraction,
    memoryContext,
    relevantMessages.length === 0
  );

  const response = await api.queryGeminiReply(context, {
    systemPrompt,
    chatHistory,
    activePersona,
    turnDirective
  });

  if (onBeforeSend) {
    onBeforeSend();
  }

  const targetHuman = utils.findLatestHumanAuthor(relevantMessages);
  if (targetHuman && response?.memory) {
    utils.saveUserMemory(context, activePersona.name, targetHuman.id, response.memory);
  }

  const replyText = utils.cleanBotReply(response?.text);
  if (!replyText) {
    console.log(`[DiscordBots] [Channel ${channelConfig.name}] [Persona ${activePersona.name}] Remained silent.`);
    return false;
  }

  await api.sendWebhookMessage(context, channelConfig, activePersona, replyText);
  utils.state(context, "LAST_PERSONA", channelId, activePersona.name);
  utils.state(context, "LAST_BOT_TIME", channelId, Date.now());
  console.log(`[DiscordBots] [Channel ${channelConfig.name}] [Persona ${activePersona.name} (${activePersona.language})] Sent message.`);
  return true;
}

function evaluateSandboxFlow(messages, humanUnreadMessages) {
  if (humanUnreadMessages.length > 0) {
    return { shouldSkip: false, relevantMessages: messages, shouldChangeTopic: false };
  }

  let consecutiveBotCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (utils.isBotOrWebhookMessage(messages[i])) {
      consecutiveBotCount++;
    } else {
      break;
    }
  }

  if (consecutiveBotCount >= config.MAX_BOT_BURST) {
    const lastMsg = messages[messages.length - 1];
    const elapsedMinutes = lastMsg
      ? (Date.now() - utils.getMessageTimestampMs(lastMsg)) / 60000
      : Infinity;

    if (elapsedMinutes < config.BOT_PAUSE_MINUTES) {
      return { shouldSkip: true, relevantMessages: [], shouldChangeTopic: false };
    }

    return {
      shouldSkip: false,
      relevantMessages: messages.slice(-config.POST_PAUSE_CONTEXT),
      shouldChangeTopic: true
    };
  }

  return { shouldSkip: false, relevantMessages: messages, shouldChangeTopic: false };
}

module.exports = {
  run
};
