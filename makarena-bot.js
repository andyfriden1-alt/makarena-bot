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

// ===== DATA =====
const dungeons = {};
Object.keys(dungeonCooldowns).forEach(d => {
  for (let i = 1; i <= INSTANCES; i++) {
    dungeons[`${d}-${i}`] = { lfg: [], teams: [] };
  }
});

let cooldowns = new Map();
let selectedDungeon = new Map(); // stores ONLY base (20,30...)
let selectedGroup = new Map();   // stores group (1,2,3)

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
function tryCreateTeam(dungeon) {
  const roles = ["EK","ED","MS","RP"];
  let team = {};

  for (let role of roles) {
    const p = dungeons[dungeon].lfg.find(x => x.role === role);
    if (!p) return;
    team[role] = p;
  }

  dungeons[dungeon].lfg = dungeons[dungeon].lfg.filter(p => !roles.includes(p.role));

  if (dungeons[dungeon].teams.length < MAX_TEAMS) {
    dungeons[dungeon].teams.push(team);
    Object.values(team).forEach(p => setCooldown(p.id, dungeon));
  }
}

// ===== EMBEDS =====
function buildEmbeds() {
  const icons = { EK:"🛡", ED:"💧", MS:"🔥", RP:"🏹" };

  let tiers = {};
  for (let key in dungeons) {
    const base = key.split("-")[0];
    if (!tiers[base]) tiers[base] = [];
    tiers[base].push(key);
  }

  const embeds = [];

  for (let tier in tiers) {
    const embed = new EmbedBuilder()
      .setTitle(`🎯 Dungeon ${tier}`)
      .setColor(0xff9900);

    let fields = [];

    tiers[tier].forEach(key => {
      const data = dungeons[key];
      const group = key.split("-")[1];

      let preview = data.lfg.slice(0, 2).map(p =>
        `${icons[p.role]} ${p.name}`
      ).join("\n") || "—";

      fields.push({
        name: `Group ${group}`,
        value: `👥 ${data.teams.length}\n🔍 ${data.lfg.length}\n${preview}`,
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
      new ButtonBuilder().setCustomId("join").setLabel("Join").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("leave").setLabel("Leave").setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("role")
        .setPlaceholder("Select role")
        .addOptions(["EK","ED","MS","RP"].map(r => ({
          label:r,value:r
        })))
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

    if (interaction.isChatInputCommand() && interaction.commandName === "makarena") {
      await interaction.reply({
        embeds: buildEmbeds(),
        components: getComponents()
      });
    }

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
        return interaction.reply({ content:"Select dungeon AND group first", ephemeral:true });
      }

      const key = `${dungeon}-${group}`;

      if (interaction.customId === "join") {
        if (hasCooldown(userId, key)) {
          return interaction.reply({ content:"Cooldown active", ephemeral:true });
        }
        return interaction.reply({ content:"Select role", ephemeral:true });
      }

      if (interaction.customId === "leave") {
        dungeons[key].lfg = dungeons[key].lfg.filter(p => p.id !== userId);
        await interaction.reply({ content:"Removed", ephemeral:true });
      }
    }

    // ROLE
    if (interaction.isStringSelectMenu() && interaction.customId === "role") {
      const userId = interaction.user.id;
      const dungeon = selectedDungeon.get(userId);
      const group = selectedGroup.get(userId);
      const role = interaction.values[0];

      if (!dungeon || !group) {
        return interaction.reply({ content:"Select dungeon AND group first", ephemeral:true });
      }

      const key = `${dungeon}-${group}`;

      if (dungeons[key].lfg.find(p => p.id === userId)) {
        return interaction.reply({ content:"Already in queue", ephemeral:true });
      }

      dungeons[key].lfg.push({
        id: userId,
        name: interaction.user.username,
        role
      });

      tryCreateTeam(key);

      await interaction.reply({ content:`Joined Dungeon ${dungeon} Group ${group}`, ephemeral:true });
    }

    // UPDATE
    if (interaction.channel) {
      const messages = await interaction.channel.messages.fetch({ limit: 10 });

      const botMsg = messages.find(m =>
        m.author.id === client.user.id &&
        m.embeds.length > 0
      );

      if (botMsg) {
        await botMsg.edit({
          embeds: buildEmbeds(),
          components: getComponents()
        });
      }
    }

  } catch (err) {
    console.error(err);
  }
});

// ===== LOGIN =====
client.login(process.env.TOKEN);