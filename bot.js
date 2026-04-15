const { Client, GatewayIntentBits, EmbedBuilder, TextChannel } = require("discord.js");
const { Pool } = require("pg");

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error("กรุณาตั้งค่า DISCORD_BOT_TOKEN");

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

let genai = null;
try {
  const { GoogleGenAI } = require("@google/genai");
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    genai = new GoogleGenAI({ apiKey: geminiKey });
    console.log("Gemini AI loaded");
  }
} catch (_) {
  console.log("Gemini AI not available (no API key)");
}

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

async function getSettings() {
  if (!pool) return null;
  try {
    const r = await pool.query("SELECT * FROM bot_settings WHERE id=1");
    return r.rows[0] ?? null;
  } catch (_) { return null; }
}

async function getLogChannel(client, guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;
  const settings = await getSettings();
  if (settings?.log_channel_id) {
    const ch = guild.channels.cache.get(settings.log_channel_id);
    if (ch instanceof TextChannel) return ch;
  }
  return guild.channels.cache.find(
    (ch) => ch instanceof TextChannel &&
    ["voice-log","voice-logs","logs","bot-log","general"].includes(ch.name)
  ) ?? null;
}

const aiChatRateMap = new Map();
function checkRateLimit(userId, limitPerHour) {
  const now = Date.now();
  const entry = aiChatRateMap.get(userId);
  if (!entry || now > entry.resetAt) {
    aiChatRateMap.set(userId, { count: 1, resetAt: now + 3600000 });
    return true;
  }
  if (entry.count >= limitPerHour) return false;
  entry.count++;
  return true;
}

function getRemainingTime(userId) {
  const entry = aiChatRateMap.get(userId);
  if (!entry) return 0;
  return Math.ceil((entry.resetAt - Date.now()) / 60000);
}

async function detectAndTranslate(text) {
  if (!genai) return null;
  try {
    const response = await genai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [{ text: `ข้อความนี้เป็นภาษาเวียดนามหรือไม่? ถ้าใช่ ให้แปลเป็นภาษาไทยอย่างเดียว ถ้าไม่ใช่ให้ตอบว่า "NO"\n\nข้อความ: "${text}"` }]
      }],
    });
    const result = (response.text ?? "").trim();
    if (result === "NO" || result.toUpperCase() === "NO") return null;
    return result;
  } catch (err) {
    console.error("Translation error:", err.message);
    return null;
  }
}

const chatHistory = new Map();
async function getAiChatReply(channelId, username, userMessage) {
  if (!genai) return "AI Chat is not configured.";
  if (!chatHistory.has(channelId)) chatHistory.set(channelId, []);
  const history = chatHistory.get(channelId);
  history.push({ role: "user", parts: [{ text: `[${username}]: ${userMessage}` }] });
  const recent = history.slice(-20);
  try {
    const response = await genai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        { role: "user", parts: [{ text: "คุณคือ AI assistant บน Discord ชื่อ Alxcer ตอบภาษาไทยเสมอ ตอบกระชับ เป็นมิตร" }] },
        ...recent,
      ],
    });
    const reply = (response.text ?? "").trim() || "ขอโทษครับ ไม่สามารถตอบได้ตอนนี้";
    history.push({ role: "model", parts: [{ text: reply }] });
    return reply;
  } catch (err) {
    console.error("AI Chat error:", err.message);
    return "ขอโทษครับ เกิดข้อผิดพลาด ลองใหม่อีกครั้งนะครับ";
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", () => {
  console.log(`Bot online: ${client.user.tag}`);
  client.user.setActivity("ดูการเข้า-ออก voice channel", { type: 3 });
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  const content = message.content.trim();
  if (!content) return;

  const settings = await getSettings();
  if (!settings) return;

  const channelId = message.channelId;
  let translationChannels = [];
  let aiChatChannels = [];
  try { translationChannels = JSON.parse(settings.translation_channels || "[]"); } catch {}
  try { aiChatChannels = JSON.parse(settings.ai_chat_channels || "[]"); } catch {}

  const isAiChat = settings.ai_chat_enabled === 1 && aiChatChannels.includes(channelId);
  const isTranslation = settings.translation_enabled === 1 &&
    (settings.translation_all_channels === 1 || translationChannels.includes(channelId));

  if (isAiChat) {
    const limit = settings.ai_chat_rate_limit_per_hour || 10;
    if (!checkRateLimit(message.author.id, limit)) {
      const remaining = getRemainingTime(message.author.id);
      await message.reply(`❌ คุณใช้งาน AI Chat เกินลิมิต ${limit} ครั้ง/ชั่วโมงแล้วครับ อีก **${remaining} นาที** จึงจะใช้ได้อีก`);
      return;
    }
    try { await message.channel.sendTyping(); } catch {}
    const reply = await getAiChatReply(channelId, message.author.username, content);
    await message.reply(reply).catch(() => {});
    return;
  }

  if (isTranslation) {
    const translation = await detectAndTranslate(content);
    if (translation) {
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: message.author.displayName, iconURL: message.author.displayAvatarURL() })
        .setTitle("🇻🇳 → 🇹🇭 แปลภาษาเวียดนาม")
        .addFields(
          { name: "ต้นฉบับ", value: content.slice(0, 1024) },
          { name: "แปลเป็นไทย", value: translation.slice(0, 1024) }
        )
        .setTimestamp();
      await message.reply({ embeds: [embed] }).catch(() => {});
    }
  }
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
