const mineflayer = require('mineflayer');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');
const { Pool } = require('pg');

// =========================
// ENV
// =========================

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

// =========================
// CHECK ENV
// =========================

const required = {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  CHANNEL_ID,

  MINECRAFT_HOST,
  MINECRAFT_PORT,
  MINECRAFT_USERNAME,
  MINECRAFT_VERSION,

  SERVER_PASSWORD,
  DATABASE_URL
};

for (const [key, value] of Object.entries(required)) {
  if (!value) {
    console.error(`❌ Не указана переменная ${key}`);
    process.exit(1);
  }
}

// =========================
// DISCORD
// =========================

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

let discordChannel = null;

// =========================
// POSTGRESQL
// =========================

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

// =========================
// DATABASE FUNCTIONS
// =========================

async function addTrackedPlayer(name, type) {
  // Удаляем игрока из обеих категорий независимо от регистра
  await pool.query(
    `DELETE FROM tracked_players WHERE LOWER(name) = LOWER($1)`,
    [name]
  );

  await pool.query(
    `INSERT INTO tracked_players (name, type)
     VALUES ($1, $2)
     ON CONFLICT (name)
     DO UPDATE SET type = EXCLUDED.type`,
    [name, type]
  );
}

async function removeTrackedPlayer(name, type) {
  await pool.query(
    `DELETE FROM tracked_players
     WHERE LOWER(name) = LOWER($1)
     AND type = $2`,
    [name, type]
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

  return result.rows[0]?.type || null;
}

async function getTrackedPlayers(type) {
  const result = await pool.query(
    `SELECT name
     FROM tracked_players
     WHERE type = $1
     ORDER BY LOWER(name)`,
    [type]
  );

  return result.rows.map(row => row.name);
}

// =========================
// COMMANDS
// =========================

const commands = [

  new SlashCommandBuilder()
    .setName('kp2')
    .setDescription('Перейти на KitPvP 2'),

  new SlashCommandBuilder()
    .setName('tab')
    .setDescription('Показать игроков онлайн'),

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
    .setName('friends')
    .setDescription('Показать список друзей'),

  new SlashCommandBuilder()
    .setName('enemies')
    .setDescription('Показать список врагов')
].map(command => command.toJSON());

// =========================
// REGISTER COMMANDS
// =========================

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

// =========================
// MINECRAFT
// =========================

let mcBot = null;
let intentionalLeave = false;
let reconnectTimer = null;
let leaveTimer = null;

let lastVerificationMessage = '';

function connectMinecraft() {

  if (mcBot) {
    try {
      mcBot.quit();
    } catch {}
  }

  intentionalLeave = false;

  console.log(
    `🔌 Подключение к ${MINECRAFT_HOST}:${MINECRAFT_PORT}...`
  );

  mcBot = mineflayer.createBot({
    host: MINECRAFT_HOST,
    port: Number(MINECRAFT_PORT),
    username: MINECRAFT_USERNAME,
    version: MINECRAFT_VERSION
  });

  // =========================
  // LOGIN
  // =========================

  mcBot.once('login', () => {
    console.log('🟢 Minecraft login успешен');
  });

  // =========================
  // SPAWN
  // =========================

  mcBot.once('spawn', async () => {

    console.log('🟢 Бот зашёл на MineBlaze');

    await sendDiscord(
      '🟢 Бот подключился к MineBlaze'
    );

    // Переход на KitPvP 2
    setTimeout(() => {
      if (mcBot) {
        console.log('➡️ Отправляю /kp2');
        mcBot.chat('/kp2');
      }
    }, 3000);

    // Через 10 минут выходим
    clearTimeout(leaveTimer);

    leaveTimer = setTimeout(async () => {

      console.log('⏰ Прошло 10 минут');

      await sendDiscord(
        '⏰ Бот пробыл на MineBlaze 10 минут и выходит.'
      );

      intentionalLeave = true;

      try {
        mcBot.quit();
      } catch {}

    }, 10 * 60 * 1000);
  });

  // =========================
  // CHAT
  // =========================

  mcBot.on('message', async (message) => {

    const text = message.toString();

    console.log(`[MC] ${text}`);

    await checkForVerification(text);
  });

  // =========================
  // KICK
  // =========================

  mcBot.on('kicked', async (reason) => {

    console.log('⚠️ Minecraft kick:', reason);

    await sendDiscord(
      `⚠️ Бот был кикнут с MineBlaze.\n\`\`\`\n${String(reason).slice(0, 1500)}\n\`\`\``
    );
  });

  // =========================
  // END
  // =========================

  mcBot.on('end', async () => {

    console.log('🔴 Minecraft соединение закрыто');

    clearTimeout(leaveTimer);

    if (intentionalLeave) {
      console.log('ℹ️ Автоматический reconnect отключён.');
      return;
    }

    scheduleReconnect();
  });

  // =========================
  // ERROR
  // =========================

  mcBot.on('error', error => {
    console.error('❌ Minecraft error:', error.message);
  });
}

// =========================
// RECONNECT
// =========================

function scheduleReconnect() {

  if (reconnectTimer) {
    return;
  }

  console.log('🔄 Переподключение через 15 секунд...');

  reconnectTimer = setTimeout(() => {

    reconnectTimer = null;

    console.log('🔄 Переподключаю Minecraft...');

    connectMinecraft();

  }, 15000);
}

// =========================
// VERIFICATION / CAPTCHA
// =========================

async function checkForVerification(text) {

  const lower = text.toLowerCase();

  const keywords = [
    'captcha',
    'капча',
    'verify',
    'verification',
    'верифика',
    'антибот',
    'anti-bot',
    'проверка'
  ];

  const isVerification = keywords.some(word =>
    lower.includes(word)
  );

  if (!isVerification) {
    return;
  }

  if (text === lastVerificationMessage) {
    return;
  }

  lastVerificationMessage = text;

  const urls = text.match(
    /https?:\/\/[^\s<>()]+/gi
  ) || [];

  let message =
    '⚠️ **MineBlaze запросил проверку бота.**\n\n';

  if (urls.length > 0) {

    message +=
      '🔗 Ссылка на проверку:\n' +
      urls.join('\n');

  } else {

    message +=
      '```text\n' +
      text.slice(0, 1500) +
      '\n```';
  }

  await sendDiscord(message);

  // Не пытаемся обходить проверку
  intentionalLeave = true;
}

// =========================
// DISPLAY NAME
// =========================

function getPlainText(value) {

  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(getPlainText).join('');
  }

  if (typeof value === 'object') {

    let result = '';

    if (typeof value.text === 'string') {
      result += value.text;
    }

    if (value.extra) {
      result += value.extra
        .map(getPlainText)
        .join('');
    }

    return result;
  }

  return '';
}

// =========================
// REMOVE MINECRAFT COLORS
// =========================

function cleanMinecraftText(text) {

  return String(text)
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// =========================
// GET RANK
// =========================

function getPlayerRank(player) {

  const username = player.username;

  let display = '';

  try {
    display = cleanMinecraftText(
      getPlainText(player.displayName)
    );
  } catch {
    display = '';
  }

  if (!display) {
    return '—';
  }

  // Убираем ник из displayName
  let beforeName = display;

  const index = display
    .toLowerCase()
    .indexOf(username.toLowerCase());

  if (index !== -1) {
    beforeName = display.slice(0, index).trim();
  }

  // Если перед ником ничего нет
  if (!beforeName) {
    return '—';
  }

  // Убираем лишние разделители
  beforeName = beforeName
    .replace(/^[\s|•»«>:_\-]+/, '')
    .replace(/[\s|•»«>:_\-]+$/, '')
    .trim();

  if (!beforeName) {
    return '—';
  }

  // Ограничиваем слишком длинные значения
  if (beforeName.length > 20) {
    return '—';
  }

  return beforeName;
}

// =========================
// TAB PLAYER
// =========================

async function formatPlayer(player) {

  const username = player.username;

  const ping =
    typeof player.ping === 'number'
      ? `${player.ping} ms`
      : '? ms';

  const rank = getPlayerRank(player);

  const type = await getPlayerType(username);

  let prefix = '👤';

  if (type === 'friend') {
    prefix = '🟢';
  }

  if (type === 'enemy') {
    prefix = '🔴';
  }

  return {
    prefix,
    rank,
    username,
    ping,
    type
  };
}

// =========================
// TAB
// =========================

async function getTabList() {

  if (!mcBot || !mcBot.players) {
    return '❌ Minecraft бот сейчас не подключён.';
  }

  const players = Object.values(mcBot.players);

  const friends = [];
  const enemies = [];
  const normal = [];

  for (const player of players) {

    if (!player || !player.username) {
      continue;
    }

    // Не показываем Staff in Vanish
    if (
      player.username
        .toLowerCase()
        .includes('staff in vanish')
    ) {
      continue;
    }

    const data = await formatPlayer(player);

    if (data.type === 'friend') {
      friends.push(data);
    } else if (data.type === 'enemy') {
      enemies.push(data);
    } else {
      normal.push(data);
    }
  }

  const sortPlayers = list =>
    list.sort((a, b) =>
      a.username
        .toLowerCase()
        .localeCompare(
          b.username.toLowerCase()
        )
    );

  sortPlayers(friends);
  sortPlayers(enemies);
  sortPlayers(normal);

  let output = '';

  // =========================
  // FRIENDS
  // =========================

  if (friends.length > 0) {

    output += '🟢 **FRIENDS**\n';
    output += '```text\n';

    for (const p of friends) {

      output +=
        `| ${p.rank.padEnd(10)} | ` +
        `${p.username.padEnd(16)} | ` +
        `${p.ping}\n`;
    }

    output += '```\n\n';
  }

  // =========================
  // ENEMIES
  // =========================

  if (enemies.length > 0) {

    output += '🔴 **ENEMIES**\n';
    output += '```text\n';

    for (const p of enemies) {

      output +=
        `| ${p.rank.padEnd(10)} | ` +
        `${p.username.padEnd(16)} | ` +
        `${p.ping}\n`;
    }

    output += '```\n\n';
  }

  // =========================
  // NORMAL
  // =========================

  if (normal.length > 0) {

    output += '👤 **PLAYERS**\n';
    output += '```text\n';

    for (const p of normal) {

      output +=
        `| ${p.rank.padEnd(10)} | ` +
        `${p.username.padEnd(16)} | ` +
        `${p.ping}\n`;
    }

    output += '```';
  }

  if (!output) {
    return '❌ Игроки не найдены.';
  }

  return output;
}

// =========================
// SEND LONG DISCORD MESSAGE
// =========================

async function sendLongDiscord(content) {

  if (!discordChannel) {
    return;
  }

  // Discord максимум ~2000 символов
  const maxLength = 1900;

  let text = content;

  while (text.length > maxLength) {

    let cut = text.lastIndexOf('\n', maxLength);

    if (cut <= 0) {
      cut = maxLength;
    }

    const part = text.slice(0, cut);

    await discordChannel.send(part);

    text = text.slice(cut);
  }

  if (text.trim()) {
    await discordChannel.send(text);
  }
}

// =========================
// SEND DISCORD
// =========================

async function sendDiscord(message) {

  try {

    if (!discordChannel) {
      discordChannel =
        await discord.channels.fetch(CHANNEL_ID);
    }

    if (!discordChannel) {
      console.error('❌ Discord канал не найден');
      return;
    }

    await sendLongDiscord(message);

  } catch (error) {

    console.error(
      '❌ Ошибка отправки Discord:',
      error.message
    );
  }
}

// =========================
// DISCORD READY
// =========================

discord.once('ready', async () => {

  console.log(
    `🤖 Discord бот запущен: ${discord.user.tag}`
  );

  try {
    discordChannel =
      await discord.channels.fetch(CHANNEL_ID);
  } catch (error) {
    console.error(
      '❌ Не удалось получить Discord канал:',
      error.message
    );
  }
});

// =========================
// DISCORD COMMANDS
// =========================

discord.on('interactionCreate', async interaction => {

  if (!interaction.isChatInputCommand()) {
    return;
  }

  try {

    // =====================
    // /kp2
    // =====================

    if (interaction.commandName === 'kp2') {

      if (!mcBot) {
        await interaction.reply(
          '❌ Minecraft бот не подключён.'
        );
        return;
      }

      mcBot.chat('/kp2');

      await interaction.reply(
        '➡️ Отправил `/kp2` в Minecraft.'
      );

      return;
    }

    // =====================
    // /tab
    // =====================

    if (interaction.commandName === 'tab') {

      await interaction.deferReply();

      const tab = await getTabList();

      await interaction.editReply(tab);

      return;
    }

    // =====================
    // /friendadd
    // =====================

    if (interaction.commandName === 'friendadd') {

      const name =
        interaction.options.getString('ник');

      await addTrackedPlayer(name, 'friend');

      await interaction.reply(
        `🟢 **${name}** добавлен в друзья.`
      );

      return;
    }

    // =====================
    // /friendremove
    // =====================

    if (interaction.commandName === 'friendremove') {

      const name =
        interaction.options.getString('ник');

      await removeTrackedPlayer(name, 'friend');

      await interaction.reply(
        `🗑️ **${name}** удалён из друзей.`
      );

      return;
    }

    // =====================
    // /enemyadd
    // =====================

    if (interaction.commandName === 'enemyadd') {

      const name =
        interaction.options.getString('ник');

      await addTrackedPlayer(name, 'enemy');

      await interaction.reply(
        `🔴 **${name}** добавлен во враги.`
      );

      return;
    }

    // =====================
    // /enemyremove
    // =====================

    if (interaction.commandName === 'enemyremove') {

      const name =
        interaction.options.getString('ник');

      await removeTrackedPlayer(name, 'enemy');

      await interaction.reply(
        `🗑️ **${name}** удалён из врагов.`
      );

      return;
    }

    // =====================
    // /friends
    // =====================

    if (interaction.commandName === 'friends') {

      const friends =
        await getTrackedPlayers('friend');

      if (friends.length === 0) {

        await interaction.reply(
          '🟢 Список друзей пуст.'
        );

        return;
      }

      await interaction.reply(
        '🟢 **FRIENDS**\n\n' +
        friends.map(name => `• ${name}`).join('\n')
      );

      return;
    }

    // =====================
    // /enemies
    // =====================

    if (interaction.commandName === 'enemies') {

      const enemies =
        await getTrackedPlayers('enemy');

      if (enemies.length === 0) {

        await interaction.reply(
          '🔴 Список врагов пуст.'
        );

        return;
      }

      await interaction.reply(
        '🔴 **ENEMIES**\n\n' +
        enemies.map(name => `• ${name}`).join('\n')
      );

      return;
    }

  } catch (error) {

    console.error(
      '❌ Ошибка Discord команды:',
      error
    );

    if (interaction.replied ||
        interaction.deferred) {

      await interaction.editReply(
        '❌ Произошла ошибка при выполнении команды.'
      ).catch(() => {});

    } else {

      await interaction.reply(
        '❌ Произошла ошибка.'
      ).catch(() => {});
    }
  }
});

// =========================
// START
// =========================

async function start() {

  try {

    await initDatabase();

    await registerCommands();

    await discord.login(DISCORD_TOKEN);

    connectMinecraft();

  } catch (error) {

    console.error(
      '❌ Ошибка запуска:',
      error
    );

    process.exit(1);
  }
}

start();
