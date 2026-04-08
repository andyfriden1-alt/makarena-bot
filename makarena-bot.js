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
const MAX_TEAMS = 3;
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
function hasCooldown(userId, dungeon) {
  const base = dungeon.split("-")[0];
  if (!cooldowns.has(userId)) return false;
  return cooldowns.get(userId)[base] > Date.now();
}

function setCooldown(userId, dungeon) {
  const base = dungeon.split("-")[0];
  const time = Date.now() + dungeonCooldowns[base] * 86400000;

  if (!cooldowns.has(userId)) cooldowns.set(userId, {});
  cooldowns.get(userId)[base] = time;
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
      .setTitle(`🎯 Dungeon ${tier}`)
      .setColor(0xff9900)
      .setFooter({ text: "Click a role to join • Auto team builder" })
      .setTimestamp();

    let fields = [];

    tiers[tier].forEach(key => {
      const data = session[key];
      const group = key.split("-")[1];

      let teamsText = data.teams.map((team, i) => {
        return `**Team ${i+1}**\n` + Object.values(team)
          .map(p => `${icons[p.role]} ${p.name}`)
          .join("\n");
      }).join("\n\n");

      let queueText = data.lfg.length > 0
        ? data.lfg.map(p => `${icons[p.role]} ${p.name}`).join("\n")
        : "—";

      fields.push({
        name: `Group ${group}`,
        value:
          `👥 Teams: ${data.teams.length}\n` +
          `🔍 Queue: ${data.lfg.length}\n\n` +
          (teamsText || "") +
          (teamsText ? "\n\n" : "") +
          queueText,
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

    // SELECT DUNGEON
    if (interaction.isStringSelectMenu() && interaction.customId === "dungeon_select") {
      selectedDungeon.set(interaction.user.id, interaction.values[0]);
      return interaction.reply({ content:`Selected Dungeon ${interaction.values[0]}`, ephemeral:true });
    }

    // SELECT GROUP
    if (interaction.isStringSelectMenu() && interaction.customId === "group_select") {
      selectedGroup.set(interaction.user.id, interaction.values[0]);
      return interaction.reply({ content:`Selected Group ${interaction.values[0]}`, ephemeral:true });
    }

    // BUTTONS
    if (interaction.isButton()) {
      const userId = interaction.user.id;
      const dungeon = selectedDungeon.get(userId);
      const group = selectedGroup.get(userId);

      if (!dungeon || !group) {
        return interaction.reply({
          content: "Select dungeon AND group first",
          ephemeral: true
        });
      }

      const key = `${dungeon}-${group}`;

      // ROLE CLICK
      if (interaction.customId.startsWith("role_")) {
        const role = interaction.customId.split("_")[1];

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

        await interaction.reply({
          content: `Joined Dungeon ${dungeon} Group ${group} as ${role}`,
          ephemeral: true
        });
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

        await interaction.reply({
          content: "Removed from all groups",
          ephemeral: true
        });
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