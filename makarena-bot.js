const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  EmbedBuilder
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const enablePresenceIntent = process.env.DISCORD_ENABLE_PRESENCE_INTENT === "true";
const OWNER_IDS = (process.env.BOT_OWNER_IDS || process.env.BOT_OWNER_ID || process.env.DISCORD_OWNER_ID || "")
  .split(",")
  .map(id => id.trim())
  .filter(Boolean);
const intents = [GatewayIntentBits.Guilds];

if (enablePresenceIntent) {
  intents.push(GatewayIntentBits.GuildPresences);
}

const client = new Client({ intents });

// ===== CONFIG =====
const INSTANCES = 3;
const MAX_PLAYERS = 4;

const dungeonCooldowns = {
  "20": 2,
  "30": 3,
  "40": 4,
  "60": 7,
  "90": 7,
  "120": 7
};

const ROLE_ORDER = ["EK", "ED", "MS", "RP"];
const STATUS_ICONS = {
  online: "\u{1F7E2}",
  idle: "\u{1F7E1}",
  dnd: "\u{1F534}",
  offline: "\u26AB"
};
const ROLE_ICONS = {
  EK: "\u{1F6E1}",
  ED: "\u{1F4A7}",
  MS: "\u{1F525}",
  RP: "\u{1F3F9}"
};
const DUNGEON_MARKERS = {
  "20": "\u{1F7E2}",
  "30": "\u{1F7E1}",
  "40": "\u{1F7E0}",
  "60": "\u{1F534}",
  "90": "\u{1F535}",
  "120": "\u{1F7E3}"
};

// ===== DATA =====
const sessions = new Map();
const sessionMessages = new Map();
const selectedDungeon = new Map();
const selectedGroup = new Map();
const selectedModerationTarget = new Map();
const cooldowns = new Map();

// ===== HELPERS =====
function createEmptyDungeons() {
  const data = {};

  Object.keys(dungeonCooldowns).forEach(dungeon => {
    for (let i = 1; i <= INSTANCES; i += 1) {
      data[`${dungeon}-${i}`] = { team: {} };
    }
  });

  return data;
}

function getSelectionKey(messageId, userId) {
  return `${messageId}:${userId}`;
}

function isBotOwner(userId) {
  return OWNER_IDS.includes(userId);
}

function canModerate(interaction) {
  if (isBotOwner(interaction.user.id)) return true;
  if (interaction.guild?.ownerId === interaction.user.id) return true;
  if (interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) return true;
  return false;
}

function getModerationKey(messageId, userId) {
  return `moderation:${messageId}:${userId}`;
}

function clearModerationState(messageId, userId) {
  selectedModerationTarget.delete(getModerationKey(messageId, userId));
}

function trimMenuText(text, maxLength = 100) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function getOccupiedSlots(session) {
  return Object.keys(session)
    .sort((a, b) => {
      const [aDungeon, aGroup] = a.split("-").map(Number);
      const [bDungeon, bGroup] = b.split("-").map(Number);
      if (aDungeon !== bDungeon) return aDungeon - bDungeon;
      return aGroup - bGroup;
    })
    .flatMap(key => {
      const [dungeon, group] = key.split("-");
      return ROLE_ORDER
        .map(role => ({ key, dungeon, group, role, player: session[key].team[role] }))
        .filter(entry => entry.player);
    });
}

function buildModerationOptions(session) {
  return getOccupiedSlots(session).slice(0, 25).map(entry =>
    new StringSelectMenuOptionBuilder()
      .setLabel(trimMenuText(entry.player.displayName || entry.player.name))
      .setDescription(`Dungeon ${entry.dungeon} • Group ${entry.group} • Role ${entry.role}`)
      .setValue(`${entry.dungeon}|${entry.group}|${entry.role}|${entry.player.id}`)
  );
}

function parseModerationTarget(value) {
  const [dungeon, group, role, userId] = value.split("|");
  if (!dungeon || !group || !role || !userId) return null;
  return { dungeon, group, role, userId };
}

function getPresenceStatus(presence, fallbackStatus) {
  return presence?.status || fallbackStatus || "offline";
}

function getStatusIcon(presence, fallbackStatus) {
  return STATUS_ICONS[getPresenceStatus(presence, fallbackStatus)] || STATUS_ICONS.offline;
}

function getInteractionStatus(interaction) {
  const cachedPresence = interaction.guild?.presences?.cache.get(interaction.user.id);
  return cachedPresence?.status || interaction.member?.presence?.status || "offline";
}

function syncSessionStatusesFromGuild(session, guild) {
  let changed = false;

  if (!guild?.presences?.cache) return changed;

  for (const sessionKey in session) {
    for (const role of ROLE_ORDER) {
      const player = session[sessionKey].team[role];
      if (!player) continue;

      const status = guild.presences.cache.get(player.id)?.status;
      if (status && player.status !== status) {
        player.status = status;
        changed = true;
      }
    }
  }

  return changed;
}

function formatCooldown(ms) {
  if (!ms || ms <= 0) return "";

  const hours = Math.floor(ms / 3600000);
  return `\u23F1 ${hours}h`;
}

function getCooldown(userId, dungeon) {
  const base = dungeon.split("-")[0];
  if (!cooldowns.has(userId)) return 0;

  const time = cooldowns.get(userId)[base];
  if (!time) return 0;

  return Math.max(0, time - Date.now());
}

function setCooldown(userId, dungeon) {
  const base = dungeon.split("-")[0];
  const time = Date.now() + dungeonCooldowns[base] * 86400000;

  if (!cooldowns.has(userId)) cooldowns.set(userId, {});
  cooldowns.get(userId)[base] = time;
}

function getGroupSize(session, key) {
  return Object.keys(session[key].team).length;
}

function isGroupFull(session, key) {
  return getGroupSize(session, key) === MAX_PLAYERS;
}

function getMemberSafe(guild, id) {
  return guild.members.cache.get(id) || null;
}

function getPresenceSafe(guild, id) {
  return guild.presences?.cache.get(id) || null;
}

async function ensurePresenceForUser(guild, userId) {
  if (!enablePresenceIntent || !guild) return getPresenceSafe(guild, userId);

  const cachedPresence = getPresenceSafe(guild, userId);
  if (cachedPresence) return cachedPresence;

  try {
    await guild.members.fetch({
      user: userId,
      withPresences: true,
      force: true,
      cache: true
    });
  } catch (error) {
    console.warn(`[presence] Could not fetch presence for ${userId} in guild ${guild.id}:`, error);
  }

  return getPresenceSafe(guild, userId);
}

function removeUserFromDungeon(session, userId, dungeon) {
  for (const sessionKey in session) {
    if (sessionKey.split("-")[0] !== dungeon) continue;

    for (const role of ROLE_ORDER) {
      if (session[sessionKey].team[role]?.id === userId) {
        delete session[sessionKey].team[role];
      }
    }
  }
}

function updateUserStatusInSession(session, userId, status) {
  let changed = false;

  for (const sessionKey in session) {
    for (const role of ROLE_ORDER) {
      const player = session[sessionKey].team[role];
      if (player?.id === userId && player.status !== status) {
        player.status = status;
        changed = true;
      }
    }
  }

  return changed;
}

function setGroupCooldownsIfFull(session, key) {
  const team = session[key].team;
  if (!ROLE_ORDER.every(role => team[role])) return;

  Object.values(team).forEach(player => setCooldown(player.id, key));
}

function getPlayerName(player, member) {
  return member?.displayName || player.displayName || player.name;
}

function formatPlayerLine(icon, name, status, cooldown) {
  return `${icon} ${name}${cooldown ? ` ${cooldown}` : ""}`;
}

async function sendInteractionNotice(interaction, content) {
  const payload = { content, ephemeral: true };

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload).catch(() => null);
    return;
  }

  await interaction.reply(payload).catch(() => null);
}

async function acknowledgeComponent(interaction) {
  if (!interaction.isMessageComponent() || interaction.deferred || interaction.replied) return;
  await interaction.deferUpdate();
}

async function replySessionExpired(interaction) {
  await sendInteractionNotice(
    interaction,
    "This party finder message is no longer active after a bot restart/deploy. Run /makarena again to create a fresh one."
  );
}

async function refreshSessionMessage(messageId) {
  const session = sessions.get(messageId);
  const meta = sessionMessages.get(messageId);

  if (!session || !meta) return;

  try {
    const channel = await client.channels.fetch(meta.channelId);
    if (!channel?.isTextBased()) return;

    const message = await channel.messages.fetch(messageId);
    const guild = channel.guild || (meta.guildId ? await client.guilds.fetch(meta.guildId).catch(() => null) : null);
    if (!message || !guild) return;

    await message.edit({
      embeds: await buildEmbeds(session, guild),
      components: getComponents(session)
    });
  } catch (error) {
    console.error(`[session] Failed to refresh party finder ${messageId}:`, error);
  }
}

// ===== EMBEDS =====
async function buildEmbeds(session, guild) {
  syncSessionStatusesFromGuild(session, guild);

  const tiers = Object.keys(dungeonCooldowns).sort((a, b) => Number(a) - Number(b));
  const embed = new EmbedBuilder()
    .setTitle("Party Finder")
    .setColor(0x2b2d31)
    .setTimestamp();

  const fields = [];

  for (let index = 0; index < tiers.length; index += 1) {
    const tier = tiers[index];
    const tierKeys = Object.keys(session)
      .filter(key => key.split("-")[0] === tier)
      .sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));

    const groupBlocks = [];

    for (const key of tierKeys) {
      const data = session[key];
      const group = key.split("-")[1];
      const partyLines = [];

      for (const role of ROLE_ORDER) {
        const player = data.team[role];

        if (!player) {
          partyLines.push(`${ROLE_ICONS[role]} -`);
          continue;
        }

        const presence = await ensurePresenceForUser(guild, player.id);
        const member = await getMemberSafe(guild, player.id);
        const name = getPlayerName(player, member);
        const status = getStatusIcon(presence, player.status);
        const cooldown = formatCooldown(getCooldown(player.id, key));

        partyLines.push(formatPlayerLine(ROLE_ICONS[role], name, status, cooldown));
      }

      groupBlocks.push(
        `${isGroupFull(session, key) ? `**Group ${group} (${getGroupSize(session, key)}/4) - FULL**` : `**Group ${group} (${getGroupSize(session, key)}/4)**`}\n${isGroupFull(session, key) ? "**READY**\n" : ""}${partyLines.join("\n")}`
      );
    }

    fields.push({
      name: `${DUNGEON_MARKERS[tier] || "\u25AA"} Dungeon ${tier}`,
      value: groupBlocks.join("\n\n"),
      inline: true
    });

    if ((index + 1) % 3 === 0 && index < tiers.length - 1) {
      fields.push({
        name: "\u200B",
        value: "\u200B",
        inline: false
      });
    }
  }

  embed.addFields(fields);
  return [embed];
}

// ===== UI =====
function getComponents(session) {
  const moderationOptions = buildModerationOptions(session);
  const ownerTargetMenu = new StringSelectMenuBuilder()
    .setCustomId("owner_target")
    .setPlaceholder(moderationOptions.length > 0 ? "Owner: select player" : "No signed players yet")
    .setDisabled(moderationOptions.length === 0)
    .addOptions(
      moderationOptions.length > 0
        ? moderationOptions
        : [
            new StringSelectMenuOptionBuilder()
              .setLabel("No signed players")
              .setValue("none")
          ]
    );

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("dungeon")
        .setPlaceholder("Dungeon")
        .addOptions(
          Object.keys(dungeonCooldowns).map(dungeon => ({
            label: `Dungeon ${dungeon}`,
            value: dungeon
          }))
        )
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("group")
        .setPlaceholder("Group")
        .addOptions(
          ["1", "2", "3"].map(group => ({
            label: `Group ${group}`,
            value: group
          }))
        )
    ),
    new ActionRowBuilder().addComponents(ownerTargetMenu),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("EK").setLabel(ROLE_ICONS.EK).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ED").setLabel(ROLE_ICONS.ED).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("MS").setLabel(ROLE_ICONS.MS).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("RP").setLabel(ROLE_ICONS.RP).setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("owner_remove").setLabel("Remove").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("owner_move").setLabel("Move").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("leave").setLabel("Leave").setStyle(ButtonStyle.Danger)
    )
  ];
}

// ===== EVENTS =====
client.on("interactionCreate", async interaction => {
  try {
    let shouldRefresh = false;

    if (interaction.isChatInputCommand() && interaction.commandName === "makarena") {
      const data = createEmptyDungeons();

      const message = await interaction.reply({
        embeds: await buildEmbeds(data, interaction.guild),
        components: getComponents(data),
        fetchReply: true
      });

      sessions.set(message.id, data);
      sessionMessages.set(message.id, {
        channelId: interaction.channelId,
        guildId: interaction.guildId
      });
      console.log(`[interaction] Created party finder message ${message.id}`);
      return;
    }

    const messageId = interaction.message?.id;
    if (!messageId) {
      if (interaction.isMessageComponent()) {
        await sendInteractionNotice(interaction, "Could not identify the source message for this interaction.");
      }
      return;
    }

    await acknowledgeComponent(interaction);

    const session = sessions.get(messageId);
    if (!session) {
      await replySessionExpired(interaction);
      return;
    }

    const selectionKey = getSelectionKey(messageId, interaction.user.id);

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "dungeon") {
        selectedDungeon.set(selectionKey, interaction.values[0]);
        console.log(`[interaction] ${interaction.user.tag} selected dungeon ${interaction.values[0]} on ${messageId}`);
      }

      if (interaction.customId === "group") {
        selectedGroup.set(selectionKey, interaction.values[0]);
        console.log(`[interaction] ${interaction.user.tag} selected group ${interaction.values[0]} on ${messageId}`);
      }

      if (interaction.customId === "owner_target") {
        if (!canModerate(interaction)) {
          await sendInteractionNotice(interaction, "Only the bot owner, server owner, or an administrator can use that menu.");
          return;
        }

        const moderationKey = getModerationKey(messageId, interaction.user.id);
        const moderationTarget = selectedModerationTarget.get(moderationKey);
        const parsedTarget = parseModerationTarget(interaction.values[0]);

        if (!moderationTarget?.mode) {
          await sendInteractionNotice(interaction, "Click Remove or Move first, then choose a player.");
          return;
        }

        if (!parsedTarget) {
          await sendInteractionNotice(interaction, "Could not read that player selection.");
          return;
        }

        const targetKey = `${parsedTarget.dungeon}-${parsedTarget.group}`;
        const currentPlayer = session[targetKey]?.team[parsedTarget.role];

        if (!currentPlayer || currentPlayer.id !== parsedTarget.userId) {
          clearModerationState(messageId, interaction.user.id);
          await sendInteractionNotice(interaction, "That player is no longer in that slot. Try again.");
          await refreshSessionMessage(messageId);
          return;
        }

        if (moderationTarget.mode === "remove") {
          delete session[targetKey].team[parsedTarget.role];
          clearModerationState(messageId, interaction.user.id);
          console.log(
            `[moderation] ${interaction.user.tag} removed ${currentPlayer.displayName || currentPlayer.name} from dungeon ${parsedTarget.dungeon} group ${parsedTarget.group} role ${parsedTarget.role}`
          );
          await sendInteractionNotice(
            interaction,
            `Removed ${currentPlayer.displayName || currentPlayer.name} from Dungeon ${parsedTarget.dungeon}, Group ${parsedTarget.group}, role ${parsedTarget.role}.`
          );
          await refreshSessionMessage(messageId);
          return;
        }

        selectedModerationTarget.set(moderationKey, {
          ...moderationTarget,
          userId: parsedTarget.userId,
          sourceDungeon: parsedTarget.dungeon,
          sourceGroup: parsedTarget.group,
          sourceRole: parsedTarget.role
        });
        await sendInteractionNotice(
          interaction,
          `Selected ${currentPlayer.displayName || currentPlayer.name} from Dungeon ${parsedTarget.dungeon}, Group ${parsedTarget.group}, role ${parsedTarget.role}. Now choose destination dungeon/group and click the new role.`
        );
        return;
      }

      return;
    }

    if (interaction.isButton()) {
      const userId = interaction.user.id;
      const ownerAction = canModerate(interaction);
      const dungeon = selectedDungeon.get(selectionKey);
      const group = selectedGroup.get(selectionKey);
      const moderationKey = getModerationKey(messageId, userId);
      const moderationTarget = selectedModerationTarget.get(moderationKey);

      if ((interaction.customId === "owner_remove" || interaction.customId === "owner_move") && !ownerAction) {
        await sendInteractionNotice(interaction, "Only the bot owner, server owner, or an administrator can use that button.");
        return;
      }

      if (interaction.customId === "owner_remove" || interaction.customId === "owner_move") {
        selectedModerationTarget.set(moderationKey, {
          mode: interaction.customId === "owner_remove" ? "remove" : "move"
        });

        await sendInteractionNotice(
          interaction,
          interaction.customId === "owner_remove"
            ? "Remove mode active. Choose a player in the owner menu to remove them."
            : "Move mode active. Choose a player in the owner menu, then choose destination dungeon/group and click the new role."
        );
        return;
      }

      if (!dungeon || !group) {
        await sendInteractionNotice(interaction, "Pick both dungeon and group first.");
        return;
      }

      const key = `${dungeon}-${group}`;

      if (interaction.customId === "leave") {
        removeUserFromDungeon(session, userId, dungeon);
        clearModerationState(messageId, userId);

        shouldRefresh = true;
      } else {
        const existingPlayer = session[key].team[interaction.customId];

        if (ownerAction && moderationTarget && moderationTarget.mode === "move" && moderationTarget.sourceRole) {
          const sourceKey = `${moderationTarget.sourceDungeon}-${moderationTarget.sourceGroup}`;
          const currentPlayer = session[sourceKey]?.team[moderationTarget.sourceRole];

          if (!currentPlayer || currentPlayer.id !== moderationTarget.userId) {
            clearModerationState(messageId, userId);
            await sendInteractionNotice(interaction, "That player is no longer in the selected slot. Start move mode again.");
            await refreshSessionMessage(messageId);
            return;
          }

          if (
            dungeon === moderationTarget.sourceDungeon &&
            group === moderationTarget.sourceGroup &&
            interaction.customId === moderationTarget.sourceRole
          ) {
            await sendInteractionNotice(interaction, "Pick a different destination role.");
            return;
          }

          if (existingPlayer && existingPlayer.id !== moderationTarget.userId) {
            await sendInteractionNotice(interaction, "That target role is already taken.");
            return;
          }

          removeUserFromDungeon(session, currentPlayer.id, moderationTarget.sourceDungeon);
          session[key].team[interaction.customId] = {
            ...currentPlayer,
            role: interaction.customId
          };
          clearModerationState(messageId, userId);
          console.log(
            `[moderation] ${interaction.user.tag} moved ${currentPlayer.displayName || currentPlayer.name} from dungeon ${moderationTarget.sourceDungeon} group ${moderationTarget.sourceGroup} role ${moderationTarget.sourceRole} to dungeon ${dungeon} group ${group} role ${interaction.customId}`
          );
          await sendInteractionNotice(
            interaction,
            `Moved ${currentPlayer.displayName || currentPlayer.name} to Dungeon ${dungeon}, Group ${group}, role ${interaction.customId}.`
          );
          shouldRefresh = true;
          await refreshSessionMessage(messageId);
          return;
        }

        if (existingPlayer && existingPlayer.id !== userId) {
          clearModerationState(messageId, userId);

          await sendInteractionNotice(interaction, "That role is already taken in this group.");
          return;
        }

        const displayName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
        const fetchedPresence = await ensurePresenceForUser(interaction.guild, userId);
        const status = getPresenceStatus(fetchedPresence, getInteractionStatus(interaction));
        clearModerationState(messageId, userId);
        removeUserFromDungeon(session, userId, dungeon);
        session[key].team[interaction.customId] = {
          id: userId,
          name: interaction.user.username,
          displayName,
          role: interaction.customId,
          status
        };

        console.log(
          `[interaction] ${interaction.user.tag} joined dungeon ${dungeon} group ${group} as ${interaction.customId} on ${messageId} with status ${status}`
        );

        setGroupCooldownsIfFull(session, key);
        shouldRefresh = true;
      }
    }

    if (shouldRefresh) {
      await refreshSessionMessage(messageId);
    }
  } catch (error) {
    console.error("ERROR:", error);

    if (interaction.isRepliable()) {
      await sendInteractionNotice(interaction, "Something went wrong while handling that interaction.");
    }
  }
});

client.on("presenceUpdate", async (oldPresence, newPresence) => {
  const presence = newPresence || oldPresence;
  const userId = presence?.userId;
  const status = presence?.status || "offline";

  if (!userId) return;

  const refreshTasks = [];

  for (const [messageId, session] of sessions.entries()) {
    if (updateUserStatusInSession(session, userId, status)) {
      refreshTasks.push(refreshSessionMessage(messageId));
    }
  }

  if (refreshTasks.length > 0) {
    console.log(`[presence] Updated ${refreshTasks.length} party finder message(s) for user ${userId} -> ${status}`);
    await Promise.allSettled(refreshTasks);
  }
});

client.once("ready", readyClient => {
  console.log(`[startup] Logged in as ${readyClient.user.tag}`);
  console.log(`[startup] Active intents: ${intents.join(", ")}`);
  if (!enablePresenceIntent) {
    console.warn("[startup] Presence intent is disabled. Status dots will stay offline until DISCORD_ENABLE_PRESENCE_INTENT=true is enabled.");
  }
});

client.on("error", error => {
  console.error("[discord] Client error:", error);
});

client.on("shardError", error => {
  console.error("[discord] Shard error:", error);
});

process.on("unhandledRejection", error => {
  console.error("[process] Unhandled rejection:", error);
});

process.on("uncaughtException", error => {
  console.error("[process] Uncaught exception:", error);
});

if (!TOKEN) {
  console.error("[startup] Missing Discord token. Set DISCORD_TOKEN (recommended) or TOKEN in Railway variables.");
  process.exit(1);
}

console.log("[startup] Starting Discord bot...");
client.login(TOKEN).catch(error => {
  console.error("[startup] Discord login failed:", error);
  process.exit(1);
});
