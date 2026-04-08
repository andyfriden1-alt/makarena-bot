const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ]
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

      // PARTY
      const partyLines = [];

      for (let role of ["EK","ED","MS","RP"]) {
        const player = data.team[role];

        if (!player) {
          partyLines.push(`${icons[role]} —`);
          continue;
        }

        const member = await guild.members.fetch(player.id).catch(() => null);
        const name = member?.displayName || player.name;
        const status = getStatus(member);
        const cd = formatCooldown(getCooldown(player.id, key));

        partyLines.push(`${status} ${icons[role]} ${name} ${cd}`);
      }

      // QUEUE
      const queueLines = [];

      for (let p of data.lfg) {
        const member = await guild.members.fetch(p.id).catch(() => null);
        const name = member?.displayName || p.name;
        const status = getStatus(member);
        const cd = formatCooldown(getCooldown(p.id, key));

        queueLines.push(`${status} ${icons[p.role]} ${name} ${cd}`);
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

    if (interaction.isChatInputCommand()) {
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
    if (!msgId) return;

    const session = sessions.get(msgId);
    if (!session) return;

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "dungeon") {
        selectedDungeon.set(interaction.user.id, interaction.values[0]);
      }
      if (interaction.customId === "group") {
        selectedGroup.set(interaction.user.id, interaction.values[0]);
      }
      return interaction.deferUpdate();
    }

    if (interaction.isButton()) {
      const userId = interaction.user.id;
      const dungeon = selectedDungeon.get(userId);
      const group = selectedGroup.get(userId);

      if (!dungeon || !group) {
        return interaction.reply({ content:"Pick dungeon & group first", ephemeral:true });
      }

      const key = `${dungeon}-${group}`;

      if (interaction.customId === "leave") {
        for (let k in session) {
          session[k].lfg = session[k].lfg.filter(p => p.id !== userId);
          for (let r in session[k].team) {
            if (session[k].team[r]?.id === userId) delete session[k].team[r];
          }
        }
        return interaction.deferUpdate();
      }

      const role = interaction.customId;

      if (getGroupSize(session, key) >= MAX_PLAYERS) {
        return interaction.reply({ content:"Group full (4/4)", ephemeral:true });
      }

      const existing = session[key].lfg.find(p => p.id === userId);
      if (existing) existing.role = role;
      else {
        session[key].lfg.push({
          id: userId,
          name: interaction.user.username,
          role
        });
      }

      tryBuild(session, key);
      return interaction.deferUpdate();
    }

    const msg = await interaction.channel.messages.fetch(msgId);
    if (msg) {
      await msg.edit({
        embeds: await buildEmbeds(session, interaction.guild),
        components: getComponents()
      });
    }

  } catch (e) {
    console.error(e);
  }
});

client.login(process.env.TOKEN);