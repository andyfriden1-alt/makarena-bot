const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const intents = [GatewayIntentBits.Guilds];

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

// ===== DATA =====
const sessions = new Map();
const selectedDungeon = new Map();
const selectedGroup = new Map();
const cooldowns = new Map();

// ===== HELPERS =====
function createEmptyDungeons() {
  const data = {};

  Object.keys(dungeonCooldowns).forEach(dungeon => {
    for (let i = 1; i <= INSTANCES; i += 1) {
      data[`${dungeon}-${i}`] = { lfg: [], team: {} };
    }
  });

  return data;
}

function getSelectionKey(messageId, userId) {
  return `${messageId}:${userId}`;
}

function getStatus(member) {
  if (!member?.presence) return STATUS_ICONS.offline;
  return STATUS_ICONS[member.presence.status] || STATUS_ICONS.offline;
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
  return Object.keys(session[key].team).length + session[key].lfg.length;
}

function getMemberSafe(guild, id) {
  return guild.members.cache.get(id) || null;
}

function tryBuild(session, key) {
  const team = {};

  for (const role of ROLE_ORDER) {
    const player = session[key].lfg.find(entry => entry.role === role);
    if (!player) return;
    team[role] = player;
  }

  session[key].team = team;
  session[key].lfg = session[key].lfg.filter(player => !ROLE_ORDER.includes(player.role));

  Object.values(team).forEach(player => setCooldown(player.id, key));
}

function getPlayerName(player, member) {
  return member?.displayName || player.displayName || player.name;
}

function formatPlayerLine(icon, name, status, cooldown) {
  return `${status} ${icon} ${name}${cooldown ? ` ${cooldown}` : ""}`;
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

// ===== EMBEDS =====
async function buildEmbeds(session, guild) {
  const tiers = {};

  for (const key in session) {
    const base = key.split("-")[0];
    if (!tiers[base]) tiers[base] = [];
    tiers[base].push(key);
  }

  const embeds = [];

  for (const tier in tiers) {
    const embed = new EmbedBuilder()
      .setTitle(`Party Finder - Dungeon ${tier}`)
      .setColor(0x2b2d31)
      .setFooter({
        text: `${STATUS_ICONS.online} Online • ${STATUS_ICONS.idle} Idle • ${STATUS_ICONS.dnd} DND • ${STATUS_ICONS.offline} Offline`
      })
      .setTimestamp();

    const fields = [];

    for (const key of tiers[tier]) {
      const data = session[key];
      const group = key.split("-")[1];
      const partyLines = [];
      const queueLines = [];

      for (const role of ROLE_ORDER) {
        const player = data.team[role];

        if (!player) {
          partyLines.push(`${ROLE_ICONS[role]} -`);
          continue;
        }

        const member = await getMemberSafe(guild, player.id);
        const name = getPlayerName(player, member);
        const status = getStatus(member);
        const cooldown = formatCooldown(getCooldown(player.id, key));

        partyLines.push(formatPlayerLine(ROLE_ICONS[role], name, status, cooldown));
      }

      for (const player of data.lfg) {
        const member = await getMemberSafe(guild, player.id);
        const name = getPlayerName(player, member);
        const status = getStatus(member);
        const cooldown = formatCooldown(getCooldown(player.id, key));

        queueLines.push(formatPlayerLine(ROLE_ICONS[player.role], name, status, cooldown));
      }

      fields.push({
        name: `Group ${group} (${getGroupSize(session, key)}/4)`,
        value: `**Party**\n${partyLines.join("\n")}\n\n**Queue**\n${queueLines.join("\n") || "-"}`,
        inline: true
      });
    }

    embed.addFields(fields);
    embeds.push(embed);
  }

  return embeds;
}

// ===== UI =====
function getComponents() {
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
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("EK").setLabel(ROLE_ICONS.EK).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ED").setLabel(ROLE_ICONS.ED).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("MS").setLabel(ROLE_ICONS.MS).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("RP").setLabel(ROLE_ICONS.RP).setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
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
        components: getComponents(),
        fetchReply: true
      });

      sessions.set(message.id, data);
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

      return;
    }

    if (interaction.isButton()) {
      const userId = interaction.user.id;
      const dungeon = selectedDungeon.get(selectionKey);
      const group = selectedGroup.get(selectionKey);

      if (!dungeon || !group) {
        await sendInteractionNotice(interaction, "Pick both dungeon and group first.");
        return;
      }

      const key = `${dungeon}-${group}`;

      if (interaction.customId === "leave") {
        for (const sessionKey in session) {
          session[sessionKey].lfg = session[sessionKey].lfg.filter(player => player.id !== userId);

          for (const role in session[sessionKey].team) {
            if (session[sessionKey].team[role]?.id === userId) {
              delete session[sessionKey].team[role];
            }
          }
        }

        shouldRefresh = true;
      } else {
        if (getGroupSize(session, key) >= MAX_PLAYERS) {
          await sendInteractionNotice(interaction, "Group full (4/4)");
          return;
        }

        const existing = session[key].lfg.find(player => player.id === userId);
        const displayName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;

        if (existing) {
          existing.role = interaction.customId;
          existing.displayName = displayName;
        } else {
          session[key].lfg.push({
            id: userId,
            name: interaction.user.username,
            displayName,
            role: interaction.customId
          });
        }

        console.log(
          `[interaction] ${interaction.user.tag} joined dungeon ${dungeon} group ${group} as ${interaction.customId} on ${messageId}`
        );

        tryBuild(session, key);
        shouldRefresh = true;
      }
    }

    if (shouldRefresh) {
      try {
        const message = await interaction.channel.messages.fetch(messageId);
        if (message) {
          await message.edit({
            embeds: await buildEmbeds(session, interaction.guild),
            components: getComponents()
          });
        }
      } catch (error) {
        console.error("[interaction] Failed to refresh message:", error);
      }
    }
  } catch (error) {
    console.error("ERROR:", error);

    if (interaction.isRepliable()) {
      await sendInteractionNotice(interaction, "Something went wrong while handling that interaction.");
    }
  }
});

client.once("ready", readyClient => {
  console.log(`[startup] Logged in as ${readyClient.user.tag}`);
  console.log(`[startup] Active intents: ${intents.join(", ")}`);
  console.warn("[startup] Running in Guilds-only mode. Presence dots will show offline unless privileged intents are added back later.");
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
