const { Client, GatewayIntentBits, EmbedBuilder, TextChannel, PermissionsBitField } = require("discord.js");
const { joinVoiceChannel, VoiceConnectionStatus, entersState, getVoiceConnection, EndBehaviorType } = require("@discordjs/voice");
const { Transform } = require("stream");

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error("กรุณาตั้งค่า DISCORD_BOT_TOKEN");

const WEBHOOK_URL = process.env.WEBHOOK_URL || null;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;

const API_BASE = WEBHOOK_URL
  ? WEBHOOK_URL.replace("/webhook/voice-translation", "")
  : null;

let genai = null;
try {
  const { GoogleGenAI } = require("@google/genai");
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    genai = new GoogleGenAI({ apiKey: geminiKey });
    console.log("Gemini AI loaded (direct)");
  }
} catch (_) {}

if (!genai && API_BASE) {
  console.log("Gemini AI via Replit proxy: " + API_BASE);
} else if (!genai) {
  console.log("WARNING: No Gemini AI available - translation will not work");
}

function proxyHeaders() {
  const h = { "Content-Type": "application/json" };
  if (WEBHOOK_SECRET) h["Authorization"] = `Bearer ${WEBHOOK_SECRET}`;
  return h;
}

async function proxyPost(path, body) {
  if (!API_BASE) return null;
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: proxyHeaders(),
      body: JSON.stringify(body),
    });
    if (!r.ok) { console.error(`[Proxy] ${path} failed: ${r.status}`); return null; }
    return await r.json();
  } catch (err) {
    console.error(`[Proxy] ${path} error:`, err.message);
    return null;
  }
}

async function translateAudioWithGemini(audioBase64, mimeType) {
  if (genai) {
    try {
      const response = await genai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType, data: audioBase64 } },
            { text: `ฟังเสียงนี้แล้วตอบตามรูปแบบนี้เท่านั้น:\nถ้าเป็นภาษาเวียดนาม ให้ตอบ:\nVIETNAMESE: [คำต้นฉบับภาษาเวียดนาม]\nTHAI: [คำแปลเป็นภาษาไทย]\n\nถ้าไม่ใช่ภาษาเวียดนาม หรือไม่มีเสียงพูดชัดเจน ให้ตอบ:\nNOT_VIETNAMESE` },
          ],
        }],
        config: { maxOutputTokens: 8192 },
      });
      return (response.text ?? "").trim();
    } catch (err) {
      console.error("[Gemini Direct] Audio error:", err.message);
    }
  }
  const data = await proxyPost("/webhook/translate-audio", { audioBase64, mimeType });
  return data?.result || null;
}

async function detectAndTranslate(text) {
  if (genai) {
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
      console.error("[Gemini Direct] Text error:", err.message);
    }
  }
  const data = await proxyPost("/webhook/translate-text", { text });
  return data?.result || null;
}

const chatHistory = new Map();
async function getAiChatReply(channelId, username, userMessage) {
  if (!chatHistory.has(channelId)) chatHistory.set(channelId, []);
  const history = chatHistory.get(channelId);
  history.push({ role: "user", parts: [{ text: `[${username}]: ${userMessage}` }] });
  const recent = history.slice(-20);

  if (genai) {
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
      console.error("[Gemini Direct] Chat error:", err.message);
    }
  }

  const data = await proxyPost("/webhook/ai-chat", { history: recent, username, message: userMessage });
  if (data?.reply) {
    history.push({ role: "model", parts: [{ text: data.reply }] });
    return data.reply;
  }
  return "ขอโทษครับ เกิดข้อผิดพลาด ลองใหม่อีกครั้งนะครับ";
}

async function logEvent(data) {
  await proxyPost("/webhook/voice-event", data);
}

async function logVoiceTranslation(data) {
  await proxyPost("/webhook/voice-translation", data);
}

async function getSettings() {
  if (!API_BASE) return null;
  try {
    const r = await fetch(`${API_BASE}/settings`, { headers: proxyHeaders() });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

async function getLogChannel(client, guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;
  const settings = await getSettings();
  if (settings?.logChannelId) {
    const ch = guild.channels.cache.get(settings.logChannelId);
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

function createWavHeader(dataLen, sampleRate, channels, bits) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + dataLen, 4);
  h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  h.writeUInt16LE(channels * (bits / 8), 32);
  h.writeUInt16LE(bits, 34); h.write("data", 36);
  h.writeUInt32LE(dataLen, 40);
  return h;
}

function pcmToWav(pcm, rate = 48000, ch = 2, bits = 16) {
  return Buffer.concat([createWavHeader(pcm.length, rate, ch, bits), pcm]);
}

const activeGuilds = new Map();
const processingUsers = new Set();

const voicePresence = new Map();
const afkTracker = new Map();
const AFK_WARN_MS = 3 * 60 * 1000;
const AFK_MUTE_MS = 5 * 60 * 1000;
const AFK_CHECK_INTERVAL = 15 * 1000;
const PRESENCE_SEND_INTERVAL = 20 * 1000;

function updatePresenceJoin(guildId, guildName, channelId, channelName, member) {
  if (!voicePresence.has(guildId)) {
    voicePresence.set(guildId, { guildId, guildName, channels: new Map() });
  }
  const guild = voicePresence.get(guildId);
  if (!guild.channels.has(channelId)) {
    guild.channels.set(channelId, { channelId, channelName, members: new Map() });
  }
  const ch = guild.channels.get(channelId);
  if (!ch.members.has(member.id)) {
    ch.members.set(member.id, {
      userId: member.id,
      username: member.displayName,
      avatarUrl: member.user.displayAvatarURL(),
      joinedAt: Date.now(),
    });
  }
  const afkKey = `${guildId}-${member.id}`;
  afkTracker.set(afkKey, {
    lastSpeakAt: Date.now(),
    warned: false,
    channelId,
    channelName,
    guildId,
    guildName,
    userId: member.id,
    username: member.displayName,
    avatarUrl: member.user.displayAvatarURL(),
  });
}

function updatePresenceLeave(guildId, channelId, userId) {
  const guild = voicePresence.get(guildId);
  if (!guild) return;
  const ch = guild.channels.get(channelId);
  if (ch) {
    ch.members.delete(userId);
    if (ch.members.size === 0) guild.channels.delete(channelId);
  }
  if (guild.channels.size === 0) voicePresence.delete(guildId);
  afkTracker.delete(`${guildId}-${userId}`);
}

function updatePresenceSpeak(guildId, userId) {
  const afkKey = `${guildId}-${userId}`;
  const entry = afkTracker.get(afkKey);
  if (entry) {
    entry.lastSpeakAt = Date.now();
    entry.warned = false;
  }
}

function buildPresencePayload() {
  const guilds = [];
  for (const [, guild] of voicePresence) {
    const channels = [];
    for (const [, ch] of guild.channels) {
      channels.push({
        channelId: ch.channelId,
        channelName: ch.channelName,
        members: Array.from(ch.members.values()),
      });
    }
    if (channels.length > 0) {
      guilds.push({ guildId: guild.guildId, guildName: guild.guildName, channels });
    }
  }
  return guilds;
}

async function sendPresenceUpdate() {
  const guilds = buildPresencePayload();
  await proxyPost("/webhook/voice-presence", { guilds });
}

async function checkAfkUsers(clientRef) {
  const now = Date.now();
  for (const [afkKey, entry] of afkTracker) {
    const silentMs = now - entry.lastSpeakAt;

    if (silentMs >= AFK_MUTE_MS && entry.warned) {
      try {
        const guild = clientRef.guilds.cache.get(entry.guildId);
        if (!guild) continue;
        const member = guild.members.cache.get(entry.userId);
        if (!member || !member.voice.channel) {
          afkTracker.delete(afkKey);
          continue;
        }
        if (member.voice.serverMute) continue;

        await member.voice.setMute(true, "AFK เกิน 5 นาที");

        const logChannel = await getLogChannel(clientRef, entry.guildId);
        if (logChannel) {
          const embed = new EmbedBuilder()
            .setColor(0xed4245)
            .setAuthor({ name: entry.username, iconURL: entry.avatarUrl || undefined })
            .setTitle("🔇 ปิดไมค์อัตโนมัติ — AFK")
            .setDescription(
              `ขออนุญาตปิดไมค์คุณ **${entry.username}** นะครับ เนื่องจากพบการไม่ใช้เสียงเป็นเวลานาน (${Math.floor(silentMs / 60000)} นาที)\n\nสามารถเปิดไมค์ได้เองเมื่อกลับมาครับ 🎙️`
            )
            .setFooter({ text: `ห้อง ${entry.channelName}` })
            .setTimestamp();
          await logChannel.send({ embeds: [embed] }).catch(() => {});
        }

        await proxyPost("/webhook/afk-event", {
          type: "afk-muted",
          userId: entry.userId,
          username: entry.username,
          avatarUrl: entry.avatarUrl,
          channelName: entry.channelName,
          guildName: entry.guildName,
          silentMinutes: Math.floor(silentMs / 60000),
        });

        console.log(`[AFK] Muted ${entry.username} in ${entry.channelName} (${Math.floor(silentMs / 60000)}min silent)`);
        entry.lastSpeakAt = now;
        entry.warned = false;

      } catch (err) {
        console.error(`[AFK] Mute error for ${entry.username}:`, err.message);
      }
    }

    else if (silentMs >= AFK_WARN_MS && !entry.warned) {
      entry.warned = true;
      try {
        const guild = clientRef.guilds.cache.get(entry.guildId);
        if (!guild) continue;
        const member = guild.members.cache.get(entry.userId);
        if (!member || !member.voice.channel) {
          afkTracker.delete(afkKey);
          continue;
        }
        if (member.voice.serverMute) continue;

        const logChannel = await getLogChannel(clientRef, entry.guildId);
        if (logChannel) {
          const remainMin = Math.ceil((AFK_MUTE_MS - silentMs) / 60000);
          const embed = new EmbedBuilder()
            .setColor(0xfee75c)
            .setAuthor({ name: entry.username, iconURL: entry.avatarUrl || undefined })
            .setTitle("⚠️ แจ้งเตือน AFK")
            .setDescription(
              `**${entry.username}** ไม่ได้ใช้เสียงมา ${Math.floor(silentMs / 60000)} นาทีแล้วนะครับ\n\nหากไม่พูดภายใน **${remainMin} นาที** จะถูกปิดไมค์อัตโนมัติครับ 🎙️`
            )
            .setFooter({ text: `ห้อง ${entry.channelName}` })
            .setTimestamp();
          await logChannel.send({ embeds: [embed] }).catch(() => {});
        }

        await proxyPost("/webhook/afk-event", {
          type: "afk-warning",
          userId: entry.userId,
          username: entry.username,
          avatarUrl: entry.avatarUrl,
          channelName: entry.channelName,
          guildName: entry.guildName,
          silentMinutes: Math.floor(silentMs / 60000),
        });

        console.log(`[AFK] Warning ${entry.username} in ${entry.channelName} (${Math.floor(silentMs / 60000)}min silent)`);
      } catch (err) {
        console.error(`[AFK] Warning error for ${entry.username}:`, err.message);
      }
    }
  }
}

function hasPermission(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
    member.permissions.has(PermissionsBitField.Flags.ManageChannels);
}

async function processUserAudio(connection, userId, guildId, guildName, voiceChName, voiceChId, textChannel, member) {
  const key = `${guildId}-${userId}`;
  if (processingUsers.has(key)) return;
  processingUsers.add(key);

  try {
    const opusStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 2000 },
    });

    const pcmChunks = [];
    let totalBytes = 0;
    const maxBytes = 48000 * 2 * 2 * 20;

    const OpusScript = require("opusscript");
    const decoder = new OpusScript(48000, 2, OpusScript.Application?.AUDIO ?? 2049);

    const decodeTransform = new Transform({
      transform(chunk, _enc, cb) {
        try {
          const decoded = decoder.decode(chunk);
          if (decoded) this.push(Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength));
        } catch (_) {}
        cb();
      },
    });

    opusStream.pipe(decodeTransform);

    decodeTransform.on("data", (chunk) => {
      if (totalBytes < maxBytes) { pcmChunks.push(chunk); totalBytes += chunk.length; }
    });

    await new Promise((resolve) => {
      decodeTransform.on("end", resolve);
      setTimeout(resolve, 22000);
    });

    opusStream.destroy();
    decodeTransform.destroy();

    if (totalBytes < 48000 * 2 * 2 * 0.5) return;

    const guildState = activeGuilds.get(guildId);
    if (!guildState?.enabled) return;
    if (!genai && !API_BASE) return;

    const pcmData = Buffer.concat(pcmChunks);
    const wavData = pcmToWav(pcmData);
    const wavBase64 = wavData.toString("base64");
    const durationMs = Math.round((pcmData.length / (48000 * 2 * 2)) * 1000);

    console.log(`[Voice] Processing ${(durationMs/1000).toFixed(1)}s audio from ${member.displayName}`);

    const result = await translateAudioWithGemini(wavBase64, "audio/wav");
    if (!result || result.startsWith("NOT_VIETNAMESE") || !result.includes("VIETNAMESE:")) return;

    const viMatch = result.match(/VIETNAMESE:\s*(.+)/);
    const thMatch = result.match(/THAI:\s*(.+)/);
    if (!viMatch || !thMatch) return;

    const originalText = viMatch[1].trim();
    const translatedText = thMatch[1].trim();

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: member.displayName, iconURL: member.user.displayAvatarURL() })
      .setTitle("🎙️ Voice Translation: 🇻🇳 → 🇹🇭")
      .addFields(
        { name: "Vietnamese (ต้นฉบับ)", value: originalText },
        { name: "Thai (แปล)", value: translatedText }
      )
      .setFooter({ text: `จากห้อง ${voiceChName} • ${(durationMs / 1000).toFixed(1)}s` })
      .setTimestamp();

    await textChannel.send({ embeds: [embed] }).catch(() => {});

    await logVoiceTranslation({
      guildId, guildName, channelId: voiceChId, channelName: voiceChName,
      userId, username: member.displayName,
      avatarUrl: member.user.displayAvatarURL(),
      originalText, translatedText, audioDurationMs: durationMs,
    });

    console.log(`[Voice] Translated: "${originalText}" → "${translatedText}"`);
  } catch (err) {
    console.error("[Voice] Processing error:", err.message);
  } finally {
    processingUsers.delete(key);
  }
}

function startListening(connection, guildId, guildName, voiceChannel, textChannel) {
  connection.receiver.speaking.on("start", (userId) => {
    updatePresenceSpeak(guildId, userId);

    const state = activeGuilds.get(guildId);
    if (!state?.enabled) return;
    const member = voiceChannel.guild.members.cache.get(userId);
    if (!member || member.user.bot) return;
    processUserAudio(connection, userId, guildId, guildName, voiceChannel.name, voiceChannel.id, textChannel, member);
  });
}

async function handleVoiceCommand(command, member, textChannel, voiceChannel) {
  if (!hasPermission(member)) {
    await textChannel.send("❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้ (ต้องเป็น Admin/Moderator)");
    return;
  }

  const guildId = member.guild.id;

  switch (command) {
    case "vjoin": {
      if (!voiceChannel) {
        await textChannel.send("❌ คุณต้องอยู่ในห้อง voice ก่อนครับ");
        return;
      }
      const existing = getVoiceConnection(guildId);
      if (existing) {
        await textChannel.send("⚠️ บอทอยู่ในห้อง voice อยู่แล้วครับ ใช้ `!vleave` เพื่อออกก่อน");
        return;
      }
      try {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId,
          adapterCreator: member.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: true,
        });

        connection.on("stateChange", (o, n) => {
          console.log(`[Voice] Connection: ${o.status} → ${n.status}`);
        });

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
          try {
            await Promise.race([
              entersState(connection, VoiceConnectionStatus.Signalling, 5000),
              entersState(connection, VoiceConnectionStatus.Connecting, 5000),
            ]);
          } catch {
            connection.destroy();
            activeGuilds.delete(guildId);
            console.log("[Voice] Connection destroyed after disconnect");
          }
        });

        await entersState(connection, VoiceConnectionStatus.Ready, 30000);

        activeGuilds.set(guildId, { enabled: true, textChannelId: textChannel.id });
        startListening(connection, guildId, member.guild.name, voiceChannel, textChannel);

        const embed = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("🎙️ Voice Translator เปิดแล้ว")
          .setDescription(
            `เข้าห้อง **${voiceChannel.name}** แล้วครับ\nกำลังฟังภาษาเวียดนามและแปลเป็นไทยอัตโนมัติ`
          )
          .addFields({ name: "คำสั่ง", value: "`!voff` ปิดชั่วคราว\n`!von` เปิดใหม่\n`!vleave` ออกจากห้อง" })
          .setFooter({ text: `เปิดโดย ${member.displayName}` })
          .setTimestamp();
        await textChannel.send({ embeds: [embed] });
        console.log(`[Voice] Joined ${voiceChannel.name} in ${member.guild.name}`);
      } catch (err) {
        console.error("[Voice] Join failed:", err.message);
        const conn = getVoiceConnection(guildId);
        if (conn) conn.destroy();
        await textChannel.send("❌ ไม่สามารถเข้าห้อง voice ได้ ลองใหม่อีกครั้งครับ");
      }
      break;
    }
    case "vleave": {
      const conn = getVoiceConnection(guildId);
      if (!conn) { await textChannel.send("❌ บอทไม่ได้อยู่ในห้อง voice ครับ"); return; }
      conn.destroy();
      activeGuilds.delete(guildId);
      await textChannel.send("👋 ออกจากห้อง voice แล้วครับ — Voice Translator ปิดแล้ว");
      break;
    }
    case "von": {
      const state = activeGuilds.get(guildId);
      if (!state) { await textChannel.send("❌ บอทไม่ได้อยู่ในห้อง voice ครับ ใช้ `!vjoin` ก่อน"); return; }
      state.enabled = true;
      await textChannel.send("✅ Voice Translator **เปิด**แล้วครับ — กำลังฟังภาษาเวียดนาม");
      break;
    }
    case "voff": {
      const state = activeGuilds.get(guildId);
      if (!state) { await textChannel.send("❌ บอทไม่ได้อยู่ในห้อง voice ครับ"); return; }
      state.enabled = false;
      await textChannel.send("⏸️ Voice Translator **ปิด**ชั่วคราวครับ — ใช้ `!von` เพื่อเปิดใหม่");
      break;
    }
  }
}

const processingMessages = new Set();

async function handleVoiceMessageTranslation(message) {
  if (!genai && !API_BASE) return;
  const isVoiceMsg = (message.flags.bitfield & (1 << 13)) !== 0;
  const audioAttachment = message.attachments.find(
    (a) => a.contentType?.startsWith("audio/") || a.name?.endsWith(".ogg") || a.name?.endsWith(".wav") || a.name?.endsWith(".mp3")
  );
  if (!isVoiceMsg && !audioAttachment) return;

  const attachment = audioAttachment ?? message.attachments.first();
  if (!attachment?.url) return;
  if (processingMessages.has(message.id)) return;
  processingMessages.add(message.id);

  try {
    const resp = await fetch(attachment.url);
    if (!resp.ok) return;
    const buf = Buffer.from(await resp.arrayBuffer());
    const base64 = buf.toString("base64");
    const mime = attachment.contentType || "audio/ogg";
    const durMs = Math.round((attachment.duration ?? 0) * 1000);

    const result = await translateAudioWithGemini(base64, mime);
    if (!result || result.startsWith("NOT_VIETNAMESE") || !result.includes("VIETNAMESE:")) return;
    const viMatch = result.match(/VIETNAMESE:\s*(.+)/);
    const thMatch = result.match(/THAI:\s*(.+)/);
    if (!viMatch || !thMatch) return;

    const originalText = viMatch[1].trim();
    const translatedText = thMatch[1].trim();
    const chName = message.channel.name ?? "unknown";

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: message.member?.displayName ?? message.author.username, iconURL: message.author.displayAvatarURL() })
      .setTitle("🎙️ Voice Translation: 🇻🇳 → 🇹🇭")
      .addFields(
        { name: "Vietnamese (ต้นฉบับ)", value: originalText },
        { name: "Thai (แปล)", value: translatedText }
      )
      .setFooter({ text: `Voice Message • ${durMs > 0 ? (durMs / 1000).toFixed(1) + "s" : "audio"}` })
      .setTimestamp();
    await message.reply({ embeds: [embed] }).catch(() => {});

    await logVoiceTranslation({
      guildId: message.guild.id, guildName: message.guild.name,
      channelId: message.channelId, channelName: chName,
      userId: message.author.id, username: message.member?.displayName ?? message.author.username,
      avatarUrl: message.author.displayAvatarURL(),
      originalText, translatedText, audioDurationMs: durMs || null,
    });
  } catch (err) {
    console.error("[VoiceMsg] Error:", err.message);
  } finally {
    processingMessages.delete(message.id);
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
  client.user.setActivity("🎙️ !vjoin เพื่อแปลเสียง", { type: 3 });

  for (const guild of client.guilds.cache.values()) {
    for (const [, ch] of guild.channels.cache) {
      if (ch.isVoiceBased() && ch.members) {
        for (const [, member] of ch.members) {
          if (!member.user.bot) {
            updatePresenceJoin(guild.id, guild.name, ch.id, ch.name, member);
          }
        }
      }
    }
  }
  sendPresenceUpdate().catch(() => {});

  setInterval(() => sendPresenceUpdate().catch(() => {}), PRESENCE_SEND_INTERVAL);
  setInterval(() => checkAfkUsers(client).catch((e) => console.error("[AFK] Check error:", e.message)), AFK_CHECK_INTERVAL);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  await handleVoiceMessageTranslation(message);

  const content = message.content.trim();
  if (!content) return;

  const voiceCommands = ["!vjoin", "!vleave", "!von", "!voff"];
  if (voiceCommands.includes(content.toLowerCase())) {
    const cmd = content.toLowerCase().replace("!", "");
    const member = message.member;
    if (!member) return;
    const voiceChannel = member.voice.channel;
    const textChannel = message.channel;
    if (textChannel.isTextBased() && "send" in textChannel) {
      await handleVoiceCommand(cmd, member, textChannel, voiceChannel);
    }
    return;
  }

  const settings = await getSettings();
  if (!settings) return;

  const channelId = message.channelId;
  let translationChannels = [];
  let aiChatChannels = [];
  try { translationChannels = JSON.parse(settings.translationChannels || settings.translation_channels || "[]"); } catch {}
  try { aiChatChannels = JSON.parse(settings.aiChatChannels || settings.ai_chat_channels || "[]"); } catch {}

  const isAiChat = (settings.aiChatEnabled === 1 || settings.ai_chat_enabled === 1) && aiChatChannels.includes(channelId);
  const isTranslation = (settings.translationEnabled === 1 || settings.translation_enabled === 1) &&
    (settings.translationAllChannels === 1 || settings.translation_all_channels === 1 || translationChannels.includes(channelId));

  if (isAiChat) {
    const limit = settings.aiChatRateLimitPerHour || settings.ai_chat_rate_limit_per_hour || 10;
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
    updatePresenceJoin(guildId, guildName, newCh.id, newCh.name, member);
  } else if (oldCh && !newCh) {
    eventType = "leave"; channelId = oldCh.id; channelName = oldCh.name;
    color = 0xed4245; title = "ออกจากห้อง Voice";
    desc = `**${username}** ออกจากห้อง **${oldCh.name}**`;
    updatePresenceLeave(guildId, oldCh.id, member.id);
  } else if (oldCh && newCh && oldCh.id !== newCh.id) {
    eventType = "move"; channelId = newCh.id; channelName = newCh.name;
    fromChannelId = oldCh.id; fromChannelName = oldCh.name;
    color = 0xfee75c; title = "ย้ายห้อง Voice";
    desc = `**${username}** ย้ายจาก **${oldCh.name}** ไปยัง **${newCh.name}**`;
    updatePresenceLeave(guildId, oldCh.id, member.id);
    updatePresenceJoin(guildId, guildName, newCh.id, newCh.name, member);
  } else {
    return;
  }
  sendPresenceUpdate().catch(() => {});

  await logEvent({
    eventType, userId: member.id, username, avatarUrl,
    guildId, guildName, channelId, channelName,
    fromChannelId, fromChannelName,
  });

  const logChannel = await getLogChannel(client, guildId);
  if (logChannel) {
    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: username, iconURL: avatarUrl })
      .setTitle(title)
      .setDescription(desc)
      .setTimestamp()
      .setFooter({ text: guildName });
    await logChannel.send({ embeds: [embed] }).catch((err) =>
      console.error("ส่ง embed ไม่ได้:", err.message)
    );
  }
  console.log(`[Event] ${eventType}: ${username} - ${channelName}`);
});

client.on("error", (err) => {
  console.error("Discord client error:", err.message);
});

client.login(token).catch((err) => {
  console.error("Login failed:", err.message);
  process.exit(1);
});
