const mineflayer = require('mineflayer');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');
const { Pool } = require('pg');

// ======================================================
// ENV
// ======================================================

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  CHANNEL_ID,

  MINECRAFT_HOST,
  MINECRAFT_PORT,
  MINECRAFT_USERNAME,
  MINECRAFT_VERSION,
  SERVER_PASSWORD,

  DATABASE_URL
} = process.env;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL не указан');
  process.exit(1);
}

if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN не указан');
  process.exit(1);
}

if (!DISCORD_CLIENT_ID) {
  console.error('❌ DISCORD_CLIENT_ID не указан');
  process.exit(1);
}

// ======================================================
// DISCORD
// ======================================================

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

let discordChannel = null;

// ======================================================
// POSTGRESQL
// ======================================================

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracked_players (
      name TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('friend', 'enemy')),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  console.log('✅ PostgreSQL готов');
}

// ======================================================
// FRIEND / ENEMY
// ======================================================

async function addTrackedPlayer(name, type) {
  const cleanName = name.trim();

  if (!cleanName) {
    throw new Error('Пустой ник');
  }

  // Удаляем игрока из обеих групп без учёта регистра
  await pool.query(
    `DELETE FROM tracked_players WHERE LOWER(name) = LOWER($1)`,
    [cleanName]
  );

  await pool.query(
    `INSERT INTO tracked_players (name, type)
     VALUES ($1, $2)`,
    [cleanName, type]
  );
}

async function removeTrackedPlayer(name, type) {
  await pool.query(
    `DELETE FROM tracked_players
     WHERE LOWER(name) = LOWER($1)
     AND type = $2`,
    [name.trim(), type]
  );
}

async function getPlayerType(name) {
  const result = await pool.query(
    `SELECT type
     FROM tracked_players
     WHERE LOWER(name) = LOWER($1)
     LIMIT 1`,
    [name]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].type;
}

async function getPlayersByType(type) {
  const result = await pool.query(
    `SELECT name
     FROM tracked_players
     WHERE type = $1
     ORDER BY LOWER(name)`,
    [type]
  );

  return result.rows.map(row => row.name);
}

// ======================================================
// DISCORD COMMANDS
// ======================================================

const commands = [

  new SlashCommandBuilder()
    .setName('kp2')
    .setDescription('Перейти в KitPvP 2'),

  new SlashCommandBuilder()
    .setName('tab')
    .setDescription('Показать игроков с рангами и пингом'),

  new SlashCommandBuilder()
    .setName('friendadd')
    .setDescription('Добавить игрока в друзья')
    .addStringOption(option =>
      option
        .setName('ник')
        .setDescription('Ник игрока')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('friendremove')
    .setDescription('Удалить игрока из друзей')
    .addStringOption(option =>
      option
        .setName('ник')
        .setDescription('Ник игрока')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('friends')
    .setDescription('Показать список друзей'),

  new SlashCommandBuilder()
    .setName('enemyadd')
    .setDescription('Добавить игрока во враги')
    .addStringOption(option =>
      option
        .setName('ник')
        .setDescription('Ник игрока')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('enemyremove')
    .setDescription('Удалить игрока из врагов')
    .addStringOption(option =>
      option
        .setName('ник')
        .setDescription('Ник игрока')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('enemies')
    .setDescription('Показать список врагов'),

  new SlashCommandBuilder()
    .setName('reconnect')
    .setDescription('Переподключить Minecraft бота')

].map(command => command.toJSON());

// ======================================================
// REGISTER COMMANDS
// ======================================================

async function registerCommands() {
  const rest = new REST({ version: '10' })
    .setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationCommands(DISCORD_CLIENT_ID),
    {
      body: commands
    }
  );

  console.log('✅ Slash-команды зарегистрированы');
}

// ======================================================
// MINECRAFT
// ======================================================

let mcBot = null;
let intentionalLeave = false;
let reconnectTimer = null;
let tenMinuteTimer = null;

let lastVerificationMessage = '';
let verificationSent = false;

// ======================================================
// DISCORD MESSAGE
// ======================================================

async function sendDiscord(message) {
  try {
    if (!discordChannel) return;

    await discordChannel.send({
      content: message
    });
  } catch (err) {
    console.error('Discord send error:', err.message);
  }
}

// ======================================================
// CLEAN MINECRAFT TEXT
// ======================================================

function cleanMinecraftText(text) {
  if (!text) return '';

  return String(text)
    // ANSI
    .replace(/\x1b\[[0-9;]*m/g, '')

    // Minecraft formatting codes
    .replace(/§[0-9a-fk-or]/gi, '')

    // невидимые управляющие символы
    .replace(/[\u0000-\u001F\u007F]/g, '')

    .replace(/\s+/g, ' ')
    .trim();
}

// ======================================================
// GET DISPLAY NAME
// ======================================================

function getDisplayName(player) {
  try {
    if (player.displayName) {
      const text = player.displayName.toString();

      if (text) {
        return cleanMinecraftText(text);
      }
    }
  } catch {}

  return player.username;
}

// ======================================================
// GET TEAM PREFIX
// ======================================================

function getTeamPrefix(username) {
  try {
    if (!mcBot || !mcBot.teamMap || !mcBot.teams) {
      return '';
    }

    const teamName = mcBot.teamMap[username];

    if (!teamName) {
      return '';
    }

    const team = mcBot.teams[teamName];

    if (!team || !team.prefix) {
      return '';
    }

    return cleanMinecraftText(team.prefix.toString());
  } catch {
    return '';
  }
}

// ======================================================
// GET RANK
// ======================================================

function getRank(player) {
  const username = player.username;

  const prefix = getTeamPrefix(username);
  const display = getDisplayName(player);

  const combined = `${prefix} ${display}`;

  // --------------------------------------------------
  // Сначала ищем известные ранги
  // --------------------------------------------------

  const knownRanks = [
    'OWNER',
    'COOWNER',
    'CO-OWNER',
    'ADMIN',
    'MOD',
    'MODERATOR',
    'HELPER',
    'YT',
    'YOUTUBE',

    'LEGEND',
    'PREMIUM',
    'DELUXE',
    'MVP',
    'VIP',
    'VIP+',

    'KTA',
    'GOT',
    'HERO',
    'TITAN',
    'ELITE',
    'PRO'
  ];

  const upper = combined.toUpperCase();

  for (const rank of knownRanks) {
    const escaped = rank.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const regex = new RegExp(
      `(?:^|[\\s\\[\\]<>|])${escaped}(?:$|[\\s\\[\\]<>|])`,
      'i'
    );

    if (regex.test(upper)) {
      return rank;
    }
  }

  // --------------------------------------------------
  // Ищем что-нибудь в [RANK]
  // --------------------------------------------------

  const bracketMatch = combined.match(
    /\[\s*([A-Za-zА-Яа-я0-9+_-]{2,16})\s*\]/
  );

  if (bracketMatch) {
    const value = bracketMatch[1].toUpperCase();

    // Не считаем обычные технические метки рангом
    const ignored = [
      'GOTS',
      'GF',
      'MONEY',
      'SOUL',
      'HMDL',
      'XXX',
      'HC'
    ];

    if (!ignored.includes(value)) {
      return value;
    }
  }

  return '—';
}

// ======================================================
// PLAYER STATUS
// ======================================================

async function getPlayerStatus(username) {
  const type = await getPlayerType(username);

  if (type === 'friend') {
    return '🟢';
  }

  if (type === 'enemy') {
    return '🔴';
  }

  return '👤';
}

// ======================================================
// TAB ROW
// ======================================================

async function makePlayerRow(player) {
  const status = await getPlayerStatus(player.username);

  const rank = getRank(player);

  const username = player.username;

  let ping = Number(player.ping);

  if (!Number.isFinite(ping) || ping < 0) {
    ping = 0;
  }

  const rankText = rank.padEnd(10, ' ');
  const nameText = username.padEnd(18, ' ');

  return `${status} | ${rankText} | ${nameText} | ${ping} ms`;
}

// ======================================================
// TAB
// ======================================================

async function getTabList() {
  if (!mcBot) {
    return '❌ Minecraft бот не подключён.';
  }

  const players = Object.values(mcBot.players || {});

  if (players.length === 0) {
    return '❌ Игроки пока не загрузились.';
  }

  const friends = [];
  const enemies = [];
  const normal = [];

  for (const player of players) {

    // НИКАКОГО "Staff in Vanish"
    // Показываем только реальных игроков из bot.players

    const type = await getPlayerType(player.username);

    if (type === 'friend') {
      friends.push(player);
    } else if (type === 'enemy') {
      enemies.push(player);
    } else {
      normal.push(player);
    }
  }

  const sortPlayers = arr => {
    return arr.sort((a, b) =>
      a.username.localeCompare(
        b.username,
        undefined,
        { sensitivity: 'base' }
      )
    );
  };

  sortPlayers(friends);
  sortPlayers(enemies);
  sortPlayers(normal);

  const lines = [];

  lines.push('```text');
  lines.push('╔══════════════════════════════════════════════╗');
  lines.push('║                 MINEBLAZE TAB                ║');
  lines.push('╚══════════════════════════════════════════════╝');
  lines.push('');

  // --------------------------------------------------
  // FRIENDS
  // --------------------------------------------------

  lines.push('🟢 FRIENDS');

  if (friends.length === 0) {
    lines.push('  └─ Нет друзей онлайн');
  } else {
    for (const player of friends) {
      lines.push(await makePlayerRow(player));
    }
  }

  lines.push('');

  // --------------------------------------------------
  // ENEMIES
  // --------------------------------------------------

  lines.push('🔴 ENEMIES');

  if (enemies.length === 0) {
    lines.push('  └─ Нет врагов онлайн');
  } else {
    for (const player of enemies) {
      lines.push(await makePlayerRow(player));
    }
  }

  lines.push('');

  // --------------------------------------------------
  // PLAYERS
  // --------------------------------------------------

  lines.push('👤 PLAYERS');

  if (normal.length === 0) {
    lines.push('  └─ Нет игроков');
  } else {
    for (const player of normal) {
      lines.push(await makePlayerRow(player));
    }
  }

  lines.push('');
  lines.push(`Всего онлайн: ${players.length}`);
  lines.push('```');

  return lines.join('\n');
}

// ======================================================
// DISCORD TAB MESSAGE
// ======================================================

async function sendLongDiscordMessage(text) {
  // Discord ограничивает сообщение 2000 символами.
  // Разбиваем аккуратно по строкам.

  const maxLength = 1950;

  if (text.length <= maxLength) {
    await sendDiscord(text);
    return;
  }

  const lines = text.split('\n');

  let current = '';

  for (const line of lines) {

    if ((current + '\n' + line).length > maxLength) {

      if (current.trim()) {
        await sendDiscord(current);
      }

      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }

  if (current.trim()) {
    await sendDiscord(current);
  }
}

// ======================================================
// VERIFICATION / CAPTCHA LINK
// ======================================================

function checkForVerification(message) {
  const text = cleanMinecraftText(message);

  if (!text) return;

  const lower = text.toLowerCase();

  const keywords = [
    'captcha',
    'verification',
    'verify',
    'верификац',
    'проверка',
    'антибот'
  ];

  const hasKeyword = keywords.some(word =>
    lower.includes(word)
  );

  if (!hasKeyword) {
    return;
  }

  if (text === lastVerificationMessage) {
    return;
  }

  lastVerificationMessage = text;

  const urls = text.match(
    /https?:\/\/[^\s<>()]+/gi
  );

  if (urls && urls.length > 0) {

    if (!verificationSent) {
      verificationSent = true;

      sendDiscord(
        `⚠️ **MineBlaze запросил проверку бота.**\n\n` +
        urls.join('\n') +
        `\n\nПроверь бота вручную. Автоматический обход проверки не выполняется.`
      );
    }

    intentionalLeave = true;

    if (mcBot) {
      try {
        mcBot.quit('Verification required');
      } catch {}
    }

    return;
  }

  sendDiscord(
    `⚠️ **Возможная проверка MineBlaze:**\n` +
    `\`\`\`\n${text.slice(0, 1500)}\n\`\`\``
  );
}

// ======================================================
// CONNECT MINECRAFT
// ======================================================

function connectMinecraft() {

  if (mcBot) {
    try {
      mcBot.removeAllListeners();
      mcBot.quit('Reconnecting');
    } catch {}
  }

  clearTimeout(tenMinuteTimer);

  verificationSent = false;
  lastVerificationMessage = '';
  intentionalLeave = false;

  console.log(
    `🔌 Подключение к ${MINECRAFT_HOST}:${MINECRAFT_PORT}...`
  );

  mcBot = mineflayer.createBot({
    host: MINECRAFT_HOST,
    port: Number(MINECRAFT_PORT),

    username: MINECRAFT_USERNAME,

    version: MINECRAFT_VERSION || false,

    auth: 'offline'
  });

  // --------------------------------------------------
  // LOGIN
  // --------------------------------------------------

  mcBot.once('login', () => {

    console.log('✅ Minecraft бот вошёл на сервер');

    if (SERVER_PASSWORD) {

      setTimeout(() => {

        try {
          mcBot.chat(`/login ${SERVER_PASSWORD}`);
          console.log('🔐 Отправлен пароль сервера');
        } catch {}
      }, 2000);
    }
  });

  // --------------------------------------------------
  // SPAWN
  // --------------------------------------------------

  mcBot.once('spawn', async () => {

    console.log('🟢 Minecraft spawn');

    await sendDiscord(
      `🟢 Бот вошёл на **${MINECRAFT_HOST}**`
    );

    // Через 3 секунды пытаемся перейти в KitPvP 2
    setTimeout(() => {

      if (!mcBot || intentionalLeave) return;

      try {
        mcBot.chat('/kp2');
        console.log('⚔️ Отправлена команда /kp2');
      } catch {}
    }, 3000);

    // Через 10 минут выходим
    tenMinuteTimer = setTimeout(async () => {

      if (!mcBot || intentionalLeave) {
        return;
      }

      console.log('⏰ Прошло 10 минут');

      await sendDiscord(
        '⏰ **Бот был автоматически отключён после 10 минут работы.**'
      );

      intentionalLeave = true;

      try {
        mcBot.quit('10 minutes elapsed');
      } catch {}

    }, 10 * 60 * 1000);
  });

  // --------------------------------------------------
  // CHAT
  // --------------------------------------------------

  mcBot.on('message', (jsonMsg) => {

    try {
      const text = cleanMinecraftText(
        jsonMsg.toString()
      );

      if (!text) return;

      console.log(`[MC] ${text}`);

      checkForVerification(text);

    } catch (err) {
      console.error(
        'Ошибка обработки MC сообщения:',
        err.message
      );
    }
  });

  // --------------------------------------------------
  // PLAYER JOIN
  // --------------------------------------------------

  mcBot.on('playerJoined', player => {

    if (!player || !player.username) return;

    console.log(
      `➕ Игрок вошёл: ${player.username}`
    );
  });

  // --------------------------------------------------
  // PLAYER LEFT
  // --------------------------------------------------

  mcBot.on('playerLeft', player => {

    if (!player || !player.username) return;

    console.log(
      `➖ Игрок вышел: ${player.username}`
    );
  });

  // --------------------------------------------------
  // KICK
  // --------------------------------------------------

  mcBot.on('kicked', reason => {

    const text = cleanMinecraftText(
      typeof reason === 'string'
        ? reason
        : JSON.stringify(reason)
    );

    console.log(
      `❌ Minecraft kick: ${text}`
    );
  });

  // --------------------------------------------------
  // ERROR
  // --------------------------------------------------

  mcBot.on('error', err => {

    console.error(
      '❌ Minecraft error:',
      err.message
    );
  });

  // --------------------------------------------------
  // END
  // --------------------------------------------------

  mcBot.on('end', reason => {

    clearTimeout(tenMinuteTimer);

    console.log(
      `🔌 Minecraft соединение закрыто: ${reason || 'unknown'}`
    );

    if (intentionalLeave) {

      console.log(
        '🛑 Автоматический reconnect отключён.'
      );

      return;
    }

    scheduleReconnect();
  });
}

// ======================================================
// RECONNECT
// ======================================================

function scheduleReconnect() {

  if (reconnectTimer) {
    return;
  }

  console.log(
    '🔄 Переподключение через 15 секунд...'
  );

  reconnectTimer = setTimeout(() => {

    reconnectTimer = null;

    connectMinecraft();

  }, 15000);
}

// ======================================================
// DISCORD READY
// ======================================================

discord.once('ready', async () => {

  console.log(
    `🤖 Discord бот запущен: ${discord.user.tag}`
  );

  try {

    discordChannel =
      await discord.channels.fetch(CHANNEL_ID);

    console.log(
      `📢 Discord канал найден: ${discordChannel.name || CHANNEL_ID}`
    );

  } catch (err) {

    console.error(
      '❌ Не удалось найти Discord канал:',
      err.message
    );
  }
});

// ======================================================
// DISCORD INTERACTIONS
// ======================================================

discord.on('interactionCreate', async interaction => {

  if (!interaction.isChatInputCommand()) {
    return;
  }

  const command = interaction.commandName;

  // --------------------------------------------------
  // /kp2
  // --------------------------------------------------

  if (command === 'kp2') {

    if (!mcBot) {
      await interaction.reply(
        '❌ Minecraft бот не подключён.'
      );
      return;
    }

    try {

      mcBot.chat('/kp2');

      await interaction.reply(
        '⚔️ Команда `/kp2` отправлена в Minecraft.'
      );

    } catch (err) {

      await interaction.reply(
        `❌ Ошибка: ${err.message}`
      );
    }

    return;
  }

  // --------------------------------------------------
  // /tab
  // --------------------------------------------------

  if (command === 'tab') {

    await interaction.deferReply();

    try {

      const tab = await getTabList();

      await interaction.editReply({
        content: tab
      });

    } catch (err) {

      console.error(
        'TAB error:',
        err
      );

      await interaction.editReply(
        '❌ Не удалось получить TAB.'
      );
    }

    return;
  }

  // --------------------------------------------------
  // /friendadd
  // --------------------------------------------------

  if (command === 'friendadd') {

    const name =
      interaction.options.getString('ник');

    try {

      await addTrackedPlayer(
        name,
        'friend'
      );

      await interaction.reply(
        `🟢 **${name}** добавлен в друзья.`
      );

    } catch (err) {

      await interaction.reply(
        `❌ Ошибка: ${err.message}`
      );
    }

    return;
  }

  // --------------------------------------------------
  // /friendremove
  // --------------------------------------------------

  if (command === 'friendremove') {

    const name =
      interaction.options.getString('ник');

    try {

      await removeTrackedPlayer(
        name,
        'friend'
      );

      await interaction.reply(
        `🗑️ **${name}** удалён из друзей.`
      );

    } catch (err) {

      await interaction.reply(
        `❌ Ошибка: ${err.message}`
      );
    }

    return;
  }

  // --------------------------------------------------
  // /friends
  // --------------------------------------------------

  if (command === 'friends') {

    try {

      const friends =
        await getPlayersByType('friend');

      if (friends.length === 0) {

        await interaction.reply(
          '🟢 Список друзей пуст.'
        );

      } else {

        await interaction.reply(
          `🟢 **Друзья:**\n${friends
            .map(name => `• ${name}`)
            .join('\n')}`
        );
      }

    } catch (err) {

      await interaction.reply(
        `❌ Ошибка: ${err.message}`
      );
    }

    return;
  }

  // --------------------------------------------------
  // /enemyadd
  // --------------------------------------------------

  if (command === 'enemyadd') {

    const name =
      interaction.options.getString('ник');

    try {

      await addTrackedPlayer(
        name,
        'enemy'
      );

      await interaction.reply(
        `🔴 **${name}** добавлен во враги.`
      );

    } catch (err) {

      await interaction.reply(
        `❌ Ошибка: ${err.message}`
      );
    }

    return;
  }

  // --------------------------------------------------
  // /enemyremove
  // --------------------------------------------------

  if (command === 'enemyremove') {

    const name =
      interaction.options.getString('ник');

    try {

      await removeTrackedPlayer(
        name,
        'enemy'
      );

      await interaction.reply(
        `🗑️ **${name}** удалён из врагов.`
      );

    } catch (err) {

      await interaction.reply(
        `❌ Ошибка: ${err.message}`
      );
    }

    return;
  }

  // --------------------------------------------------
  // /enemies
  // --------------------------------------------------

  if (command === 'enemies') {

    try {

      const enemies =
        await getPlayersByType('enemy');

      if (enemies.length === 0) {

        await interaction.reply(
          '🔴 Список врагов пуст.'
        );

      } else {

        await interaction.reply(
          `🔴 **Враги:**\n${enemies
            .map(name => `• ${name}`)
            .join('\n')}`
        );
      }

    } catch (err) {

      await interaction.reply(
        `❌ Ошибка: ${err.message}`
      );
    }

    return;
  }

  // --------------------------------------------------
  // /reconnect
  // --------------------------------------------------

  if (command === 'reconnect') {

    await interaction.reply(
      '🔄 Переподключаю Minecraft бота...'
    );

    intentionalLeave = false;

    if (mcBot) {

      try {
        mcBot.quit('Manual reconnect');
      } catch {}
    }

    setTimeout(() => {
      connectMinecraft();
    }, 2000);

    return;
  }
});

// ======================================================
// START
// ======================================================

async function start() {

  try {

    await initDatabase();

    await registerCommands();

    await discord.login(DISCORD_TOKEN);

    connectMinecraft();

  } catch (err) {

    console.error(
      '❌ Ошибка запуска:',
      err
    );

    process.exit(1);
  }
}

start();
