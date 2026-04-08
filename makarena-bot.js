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

const client = new Client({
  intents
});

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

// ===== DATA =====
const sessions = new Map();
const selectedDungeon = new Map();
const selectedGroup = new Map();
const cooldowns = new Map();

// ===== HELPERS =====
function createEmptyDungeons() {
  const data = {};
  Object.keys(dungeonCooldowns).forEach(d => {
    for (let i = 1; i <= INSTANCES; i++) {
      data[`${d}-${i}`] = { lfg: [], team: {} };
    }
  });
  return data;
}

function getStatus(member) {
  if (!member?.presence) return "⚫";
  const s = member.presence.status;
  if (s === "online") return "🟢";
  if (s === "idle") return "🟡";
  if (s === "dnd") return "🔴";
  return "⚫";
}

function formatCooldown(ms) {
  if (!ms || ms <= 0) return "";
  const h = Math.floor(ms / 3600000);
  return `⏱ ${h}h`;
}

function getCooldown(userId, dungeon) {
  const base = dungeon.split("-")[0];
  if (!cooldowns.has(userId)) return 0;
  const t = cooldowns.get(userId)[base];
  if (!t) return 0;
  return Math.max(0, t - Date.now());
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

// ===== SAFE MEMBER FETCH =====
function getMemberSafe(guild, id) {
  return guild.members.cache.get(id) || null;
}

// ===== TEAM BUILD =====
function tryBuild(session, key) {
  const roles = ["EK","ED","MS","RP"];
  let team = {};

  for (let role of roles) {
    const p = session[key].lfg.find(x => x.role === role);
    if (!p) return;
    team[role] = p;
  }

  session[key].team = team;
  session[key].lfg = session[key].lfg.filter(p => !roles.includes(p.role));

  Object.values(team).forEach(p => setCooldown(p.id, key));
}

function getPlayerName(player, member) {
  return member?.displayName || player.displayName || player.name;
}

async function replySessionExpired(interaction) {
  if (interaction.deferred || interaction.replied) return;

  await interaction.reply({
    content: "This party finder message is no longer active after a bot restart/deploy. Run /makarena again to create a fresh one.",
    ephemeral: true
  });
}

// ===== EMBEDS =====
async function buildEmbeds(session, guild) {
  const icons = { EK:"🛡", ED:"💧", MS:"🔥", RP:"🏹" };

  let tiers = {};
  for (let key in session) {
    const base = key.split("-")[0];
    if (!tiers[base]) tiers[base] = [];
    tiers[base].push(key);
  }

  const embeds = [];

  for (let tier in tiers) {
    const embed = new EmbedBuilder()
      .setTitle(`🏹 Tibia Party Finder — Dungeon ${tier}`)
      .setColor(0x2b2d31)
      .setFooter({ text: "🟢 Online • 🟡 Idle • 🔴 DND • ⚫ Offline" })
      .setTimestamp();

    let fields = [];

    for (let key of tiers[tier]) {
      const data = session[key];
      const group = key.split("-")[1];

      const partyLines = [];

      for (let role of ["EK","ED","MS","RP"]) {
        const player = data.team[role];

        if (!player) {
          partyLines.push(`${icons[role]} —`);
          continue;
        }

        const member = await getMemberSafe(guild, player.id);
        const name = getPlayerName(player, member);
        const status = getStatus(member);
        const cd = formatCooldown(getCooldown(player.id, key));

        partyLines.push(`${status}${status ? " " : ""}${icons[role]} ${name} ${cd}`.trim());
      }

      const queueLines = [];

      for (let p of data.lfg) {
        const member = await getMemberSafe(guild, p.id);
        const name = getPlayerName(p, member);
        const status = getStatus(member);
        const cd = formatCooldown(getCooldown(p.id, key));

        queueLines.push(`${status}${status ? " " : ""}${icons[p.role]} ${name} ${cd}`.trim());
      }

      fields.push({
        name: `⚔️ Group ${group} (${getGroupSize(session, key)}/4)`,
        value:
          `**Party**\n${partyLines.join("\n")}\n\n` +
          `**Queue**\n${queueLines.join("\n") || "—"}`,
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
        .addOptions(Object.keys(dungeonCooldowns).map(d => ({
          label: `Dungeon ${d}`, value: d
        })))
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("group")
        .setPlaceholder("Group")
        .addOptions(["1","2","3"].map(g => ({
          label: `Group ${g}`, value: g
        })))
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("EK").setLabel("🛡").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ED").setLabel("💧").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("MS").setLabel("🔥").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("RP").setLabel("🏹").setStyle(ButtonStyle.Primary)
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

    // ONLY your command
    if (interaction.isChatInputCommand() && interaction.commandName === "makarena") {
      const data = createEmptyDungeons();

      const msg = await interaction.reply({
        embeds: await buildEmbeds(data, interaction.guild),
        components: getComponents(),
        fetchReply: true
      });

      sessions.set(msg.id, data);
      return;
    }

    const msgId = interaction.message?.id;
    if (!msgId) {
      if (interaction.isMessageComponent()) {
        await interaction.reply({
          content: "Could not identify the source message for this interaction.",
          ephemeral: true
        });
      }
      return;
    }

    const session = sessions.get(msgId);
    if (!session) {
      await replySessionExpired(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "dungeon") {
        selectedDungeon.set(interaction.user.id, interaction.values[0]);
      }
      if (interaction.customId === "group") {
        selectedGroup.set(interaction.user.id, interaction.values[0]);
      }
      await interaction.deferUpdate();
      return;
    }

    if (interaction.isButton()) {
      const userId = interaction.user.id;
      const dungeon = selectedDungeon.get(userId);
      const group = selectedGroup.get(userId);

      if (!dungeon || !group) {
        return interaction.reply({ content:"Pick both dungeon and group first.", ephemeral:true });
      }

      const key = `${dungeon}-${group}`;

      if (interaction.customId === "leave") {
        for (let k in session) {
          session[k].lfg = session[k].lfg.filter(p => p.id !== userId);
          for (let r in session[k].team) {
            if (session[k].team[r]?.id === userId) delete session[k].team[r];
          }
        }
        shouldRefresh = true;
        await interaction.deferUpdate();
      }
      else {
        const role = interaction.customId;

        if (getGroupSize(session, key) >= MAX_PLAYERS) {
          return interaction.reply({ content:"Group full (4/4)", ephemeral:true });
        }

        const existing = session[key].lfg.find(p => p.id === userId);
        if (existing) {
          existing.role = role;
          existing.displayName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
        } else {
          session[key].lfg.push({
            id: userId,
            name: interaction.user.username,
            displayName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
            role
          });
        }

        tryBuild(session, key);
        shouldRefresh = true;
        await interaction.deferUpdate();
      }
    }

    // SAFE UPDATE
    if (shouldRefresh) try {
      const msg = await interaction.channel.messages.fetch(msgId);
      if (msg) {
        await msg.edit({
          embeds: await buildEmbeds(session, interaction.guild),
          components: getComponents()
        });
      }
    } catch {}

  } catch (e) {
    console.error("ERROR:", e);
  }
});

client.once('ready', readyClient => {
  console.log(`[startup] Logged in as ${readyClient.user.tag}`);
  console.log(`[startup] Active intents: ${intents.join(', ')}`);
  console.warn('[startup] Running in Guilds-only mode. Presence dots will show offline unless privileged intents are added back later.');
});

client.on('error', error => {
  console.error('[discord] Client error:', error);
});

client.on('shardError', error => {
  console.error('[discord] Shard error:', error);
});

process.on('unhandledRejection', error => {
  console.error('[process] Unhandled rejection:', error);
});

process.on('uncaughtException', error => {
  console.error('[process] Uncaught exception:', error);
});

if (!TOKEN) {
  console.error('[startup] Missing Discord token. Set DISCORD_TOKEN (recommended) or TOKEN in Railway variables.');
  process.exit(1);
}

console.log('[startup] Starting Discord bot...');
client.login(TOKEN).catch(error => {
  console.error('[startup] Discord login failed:', error);
  process.exit(1);
});
