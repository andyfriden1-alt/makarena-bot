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
  intents: [GatewayIntentBits.Guilds]
});

// ===== CONFIG =====
const MAX_TEAMS = 1; // Tibia style = 1 party per group
const INSTANCES = 3;

const dungeonCooldowns = {
  "20": 2,
  "30": 3,
  "40": 4,
  "60": 7,
  "90": 7,
  "120": 7
};

// ===== SESSIONS =====
const sessions = new Map();

function createEmptyDungeons() {
  const data = {};
  Object.keys(dungeonCooldowns).forEach(d => {
    for (let i = 1; i <= INSTANCES; i++) {
      data[`${d}-${i}`] = { lfg: [], teams: [] };
    }
  });
  return data;
}

// ===== USER STATE =====
let selectedDungeon = new Map();
let selectedGroup = new Map();
let cooldowns = new Map();

// ===== COOLDOWN =====
function getCooldownRemaining(userId, dungeon) {
  const base = dungeon.split("-")[0];
  if (!cooldowns.has(userId)) return 0;

  const time = cooldowns.get(userId)[base];
  if (!time) return 0;

  const remaining = time - Date.now();
  return remaining > 0 ? remaining : 0;
}

function setCooldown(userId, dungeon) {
  const base = dungeon.split("-")[0];
  const time = Date.now() + dungeonCooldowns[base] * 86400000;

  if (!cooldowns.has(userId)) cooldowns.set(userId, {});
  cooldowns.get(userId)[base] = time;
}

// ===== HELPERS =====
function getGroupSize(session, key) {
  const teamPlayers = session[key].teams.flatMap(t => Object.values(t));
  return session[key].lfg.length + teamPlayers.length;
}

function formatCooldown(ms) {
  if (ms <= 0) return "";

  const hours = Math.floor(ms / (1000 * 60 * 60));
  return `⏱ ${hours}h`;
}

// ===== TEAM BUILDER =====
function tryCreateTeam(session, dungeon) {
  const roles = ["EK","ED","MS","RP"];
  let team = {};

  for (let role of roles) {
    const p = session[dungeon].lfg.find(x => x.role === role);
    if (!p) return;
    team[role] = p;
  }

  session[dungeon].lfg = session[dungeon].lfg.filter(p => !roles.includes(p.role));

  if (session[dungeon].teams.length < MAX_TEAMS) {
    session[dungeon].teams.push(team);
    Object.values(team).forEach(p => setCooldown(p.id, dungeon));
  }
}

// ===== EMBEDS =====
function buildEmbeds(session) {
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
      .setFooter({ text: "🟢 Online • ⏱ Cooldown shown • Max 4 players" })
      .setTimestamp();

    let fields = [];

    tiers[tier].forEach(key => {
      const data = session[key];
      const group = key.split("-")[1];

      // TEAM SLOTS
      let teamSlots = ["EK","ED","MS","RP"].map(role => {
        let player = Object.values(data.teams[0] || {}).find(p => p.role === role);

        if (!player) return `${icons[role]} —`;

        const cd = formatCooldown(getCooldownRemaining(player.id, key));

        return `🟢 ${icons[role]} ${player.name} ${cd}`;
      }).join("\n");

      // QUEUE
      let queue = data.lfg.map(p => {
        const cd = formatCooldown(getCooldownRemaining(p.id, key));
        return `🟢 ${icons[p.role]} ${p.name} ${cd}`;
      }).join("\n") || "—";

      fields.push({
        name: `⚔️ Group ${group} (${getGroupSize(session, key)}/4)`,
        value:
          `**Party**\n${teamSlots}\n\n` +
          `**Queue**\n${queue}`,
        inline: true
      });
    });

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
        .setCustomId("dungeon_select")
        .setPlaceholder("Select dungeon")
        .addOptions(Object.keys(dungeonCooldowns).map(d => ({
          label: `Dungeon ${d}`,
          value: d
        })))
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("group_select")
        .setPlaceholder("Select group")
        .addOptions(["1","2","3"].map(g => ({
          label: `Group ${g}`,
          value: g
        })))
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("role_EK").setLabel("🛡 EK").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("role_ED").setLabel("💧 ED").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("role_MS").setLabel("🔥 MS").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("role_RP").setLabel("🏹 RP").setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("leave").setLabel("Leave").setStyle(ButtonStyle.Danger)
    )
  ];
}

// ===== READY =====
client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ===== INTERACTIONS =====
client.on("interactionCreate", async interaction => {
  try {

    // CREATE SESSION
    if (interaction.isChatInputCommand() && interaction.commandName === "makarena") {
      const sessionData = createEmptyDungeons();

      const msg = await interaction.reply({
        embeds: buildEmbeds(sessionData),
        components: getComponents(),
        fetchReply: true
      });

      sessions.set(msg.id, sessionData);
      return;
    }

    const messageId = interaction.message?.id;
    if (!messageId) return;

    const session = sessions.get(messageId);
    if (!session) return;

    // SELECTS (NO SPAM)
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "dungeon_select") {
        selectedDungeon.set(interaction.user.id, interaction.values[0]);
      }

      if (interaction.customId === "group_select") {
        selectedGroup.set(interaction.user.id, interaction.values[0]);
      }

      return interaction.deferUpdate();
    }

    // BUTTONS
    if (interaction.isButton()) {
      const userId = interaction.user.id;
      const dungeon = selectedDungeon.get(userId);
      const group = selectedGroup.get(userId);

      if (!dungeon || !group) {
        return interaction.reply({
          content: "Select dungeon & group first",
          ephemeral: true
        });
      }

      const key = `${dungeon}-${group}`;

      // ROLE CLICK
      if (interaction.customId.startsWith("role_")) {
        const role = interaction.customId.split("_")[1];

        if (getGroupSize(session, key) >= 4) {
          return interaction.reply({
            content: "🚫 Group is full (4/4)",
            ephemeral: true
          });
        }

        const existing = session[key].lfg.find(p => p.id === userId);

        if (existing) {
          existing.role = role;
        } else {
          session[key].lfg.push({
            id: userId,
            name: interaction.user.username,
            role
          });
        }

        tryCreateTeam(session, key);

        return interaction.deferUpdate();
      }

      // LEAVE
      if (interaction.customId === "leave") {
        for (let k in session) {
          session[k].lfg = session[k].lfg.filter(p => p.id !== userId);

          session[k].teams.forEach(team => {
            for (let r in team) {
              if (team[r]?.id === userId) delete team[r];
            }
          });
        }

        return interaction.deferUpdate();
      }
    }

    // UPDATE MESSAGE
    const botMsg = await interaction.channel.messages.fetch(messageId);

    if (botMsg) {
      await botMsg.edit({
        embeds: buildEmbeds(session),
        components: getComponents()
      });
    }

  } catch (err) {
    console.error(err);
  }
});

// ===== LOGIN =====
client.login(process.env.TOKEN);