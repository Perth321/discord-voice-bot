const { Client, GatewayIntentBits, EmbedBuilder, TextChannel } = require("discord.js");
const { Pool } = require("pg");

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error("กรุณาตั้งค่า DISCORD_BOT_TOKEN");

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

async function logEvent(data) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO voice_events (event_type, user_id, username, avatar_url, guild_id, guild_name, channel_id, channel_name, from_channel_id, from_channel_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [data.eventType, data.userId, data.username, data.avatarUrl,
       data.guildId, data.guildName, data.channelId, data.channelName,
       data.fromChannelId ?? null, data.fromChannelName ?? null]
    );
  } catch (_) {}
}

async function getLogChannel(client, guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;
  if (pool) {
    try {
      const r = await pool.query("SELECT log_channel_id FROM bot_settings WHERE id=1");
      if (r.rows[0]?.log_channel_id) {
        const ch = guild.channels.cache.get(r.rows[0].log_channel_id);
        if (ch instanceof TextChannel) return ch;
      }
    } catch (_) {}
  }
  return guild.channels.cache.find(
    (ch) => ch instanceof TextChannel &&
    ["voice-log","voice-logs","logs","bot-log","general"].includes(ch.name)
  ) ?? null;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once("ready", () => {
  console.log(`Bot online: ${client.user.tag}`);
  client.user.setActivity("ดูการเข้า-ออก voice channel", { type: 3 });
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;

  const guildId = newState.guild.id;
  const guildName = newState.guild.name;
  const oldCh = oldState.channel;
  const newCh = newState.channel;
  const username = member.displayName;
  const avatarUrl = member.user.displayAvatarURL();

  let eventType, channelId, channelName, fromChannelId = null, fromChannelName = null;
  let color, title, desc;

  if (!oldCh && newCh) {
    eventType = "join"; channelId = newCh.id; channelName = newCh.name;
    color = 0x57f287; title = "เข้าห้อง Voice";
    desc = `**${username}** เข้าห้อง **${newCh.name}**`;
  } else if (oldCh && !newCh) {
    eventType = "leave"; channelId = oldCh.id; channelName = oldCh.name;
    color = 0xed4245; title = "ออกจากห้อง Voice";
    desc = `**${username}** ออกจากห้อง **${oldCh.name}**`;
  } else if (oldCh && newCh && oldCh.id !== newCh.id) {
    eventType = "move"; channelId = newCh.id; channelName = newCh.name;
    fromChannelId = oldCh.id; fromChannelName = oldCh.name;
    color = 0xfee75c; title = "ย้ายห้อง Voice";
    desc = `**${username}** ย้ายจาก **${oldCh.name}** ไปยัง **${newCh.name}**`;
  } else return;

  await logEvent({ eventType, userId: member.id, username, avatarUrl, guildId, guildName, channelId, channelName, fromChannelId, fromChannelName });

  const logCh = await getLogChannel(client, guildId);
  if (logCh) {
    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: username, iconURL: avatarUrl })
      .setTitle(title)
      .setDescription(desc)
      .setTimestamp()
      .setFooter({ text: guildName });
    await logCh.send({ embeds: [embed] }).catch(() => {});
  }
  console.log(`[${eventType}] ${username} - ${channelName}`);
});

client.on("error", console.error);
client.login(token);
