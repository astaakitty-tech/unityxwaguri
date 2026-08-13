// bot.js
// Бот заходит на Minecraft-сервер, считывает список игроков (таб-лист)
// и отправляет его в указанный канал Discord.
//
// Запуск: npm install && npm start

require('dotenv').config()
const mineflayer = require('mineflayer')
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js')

// ========================= НАСТРОЙКИ (.env) =========================
const {
  MC_HOST,
  MC_PORT = '25565',
  MC_USERNAME = 'TabBot',
  MC_VERSION,              // например "1.21.4"; можно оставить пустым — определится сама
  MC_AUTH = 'offline',     // 'offline' для крякнутых серверов, 'microsoft' для лицензионного аккаунта

  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  COMMAND_PREFIX = '!',
} = process.env

if (!MC_HOST || !DISCORD_TOKEN || !DISCORD_CHANNEL_ID) {
  console.error('Ошибка: заполни MC_HOST, DISCORD_TOKEN и DISCORD_CHANNEL_ID в файле .env')
  process.exit(1)
}

const GAMEMODE_NAMES = ['Выживание', 'Творческий', 'Приключение', 'Наблюдатель']
const gamemodeName = (id) => GAMEMODE_NAMES[id] ?? 'Неизвестно'

// ========================= DISCORD =========================
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // привилегированный intent — включи его в Developer Portal
  ],
})

let mcBot = null

discord.once('ready', () => {
  console.log(`[Discord] Вошёл как ${discord.user.tag}`)
})

// Команда !tab (или !players) — прислать список игроков по запросу
discord.on('messageCreate', async (message) => {
  if (message.author.bot) return
  if (message.channelId !== DISCORD_CHANNEL_ID) return

  const content = message.content.trim().toLowerCase()
  if (content !== `${COMMAND_PREFIX}tab` && content !== `${COMMAND_PREFIX}players`) return

  await message.channel.send({ embeds: [buildTabEmbed()] }).catch((err) =>
    console.error('[Discord] Не удалось отправить сообщение:', err)
  )
})

discord.login(DISCORD_TOKEN)

// ========================= ТАБ-ЛИСТ → EMBED =========================
function buildTabEmbed() {
  if (!mcBot || !mcBot.player) {
    return new EmbedBuilder()
      .setTitle('Таб-лист')
      .setDescription('⚠️ Бот сейчас не подключён к серверу.')
      .setColor(0xe74c3c)
  }

  const players = Object.values(mcBot.players).filter(
    (p) => p.username !== mcBot.username
  )

  const lines = players.map((p) => {
    const ping = typeof p.ping === 'number' ? `${p.ping} мс` : '—'
    const mode = p.gamemode !== undefined ? `, ${gamemodeName(p.gamemode)}` : ''
    return `• **${p.username}** — ${ping}${mode}`
  })

  return new EmbedBuilder()
    .setTitle(`Онлайн на сервере: ${players.length}`)
    .setDescription(lines.length ? lines.join('\n') : 'Сейчас на сервере никого нет.')
    .setColor(0x2ecc71)
    .setFooter({ text: MC_HOST })
    .setTimestamp()
}

async function sendTabToDiscord() {
  try {
    const channel = await discord.channels.fetch(DISCORD_CHANNEL_ID)
    await channel.send({ embeds: [buildTabEmbed()] })
  } catch (err) {
    console.error('[Discord] Не удалось отправить таб-лист:', err.message)
  }
}

// ========================= MINECRAFT =========================
let reconnectTimer = null

function connectMinecraftBot() {
  mcBot = mineflayer.createBot({
    host: MC_HOST,
    port: Number(MC_PORT),
    username: MC_USERNAME,
    version: MC_VERSION || false,
    auth: MC_AUTH, // 'offline' | 'microsoft'
  })

  mcBot.once('spawn', () => {
    console.log('[Minecraft] Бот зашёл на сервер')
    // небольшая пауза, чтобы сервер успел прислать полный список игроков
    setTimeout(sendTabToDiscord, 3000)
  })

  mcBot.on('kicked', (reason) => {
    console.log('[Minecraft] Бота кикнули с сервера:', reason)
  })

  mcBot.on('error', (err) => {
    console.log('[Minecraft] Ошибка соединения:', err.message)
  })

  mcBot.on('end', () => {
    console.log('[Minecraft] Соединение потеряно, переподключение через 15 секунд…')
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connectMinecraftBot, 15000)
  })
}

connectMinecraftBot()

// Аккуратное завершение по Ctrl+C
process.on('SIGINT', () => {
  console.log('\nЗавершение работы…')
  clearTimeout(reconnectTimer)
  if (mcBot) mcBot.quit()
  discord.destroy()
  process.exit(0)
})
