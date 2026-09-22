// ==========================================
// MineBlaze Discord Bot
// ==========================================

const mineflayer = require('mineflayer');
const { Pool } = require('pg');

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');

// ==========================================
// ENV
// ==========================================

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;

const MINECRAFT_HOST =
  process.env.MINECRAFT_HOST || 'mc.mineblaze.net';

const MINECRAFT_PORT =
  Number(process.env.MINECRAFT_PORT || 25565);

const MINECRAFT_USERNAME =
  process.env.MINECRAFT_USERNAME;

const MINECRAFT_VERSION =
  process.env.MINECRAFT_VERSION || undefined;

const SERVER_PASSWORD =
  process.env.SERVER_PASSWORD;

const DATABASE_URL =
  process.env.DATABASE_URL;

// ==========================================
// CHECK ENV
// ==========================================

if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN не указан');
  process.exit(1);
}

if (!DISCORD_CLIENT_ID) {
  console.error('❌ DISCORD_CLIENT_ID не указан');
  process.exit(1);
}

if (!CHANNEL_ID) {
  console.error('❌ CHANNEL_ID не указан');
  process.exit(1);
}

if (!MINECRAFT_USERNAME) {
  console.error('❌ MINECRAFT_USERNAME не указан');
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL не указан');
  process.exit(1);
}

// ==========================================
// POSTGRESQL
// ==========================================

const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS tracked_players (
      name TEXT PRIMARY KEY,
      type TEXT NOT NULL
        CHECK (type IN ('friend', 'enemy')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('✅ PostgreSQL готов');
}

// ==========================================
// DISCORD
// ==========================================

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

let discordChannel = null;

async function getDiscordChannel() {
  try {
    if (discordChannel) {
      return discordChannel;
    }

    discordChannel =
      await discord.channels.fetch(CHANNEL_ID);

    if (!discordChannel) {
      console.error(
        '❌ Discord канал не найден'
      );

      return null;
    }

    return discordChannel;

  } catch (err) {
    console.error(
      '❌ Ошибка получения Discord канала:',
      err.message
    );

    return null;
  }
}

async function sendDiscord(message) {
  try {
    const channel =
      await getDiscordChannel();

    if (!channel) return;

    await channel.send(message);

  } catch (err) {
    console.error(
      '❌ Ошибка отправки в Discord:',
      err.message
    );
  }
}

// ==========================================
// FRIENDS / ENEMIES
// ==========================================

async function addTrackedPlayer(name, type) {
  name = name.trim();

  // Игрок не может одновременно быть другом и врагом
  await db.query(
    `
    DELETE FROM tracked_players
    WHERE LOWER(name) = LOWER($1)
    `,
    [name]
  );

  await db.query(
    `
    INSERT INTO tracked_players
      (name, type)
    VALUES
      ($1, $2)
    `,
    [name, type]
  );
}

async function removeTrackedPlayer(name, type) {
  const result = await db.query(
    `
    DELETE FROM tracked_players
    WHERE LOWER(name) = LOWER($1)
      AND type = $2
    RETURNING name
    `,
    [
      name.trim(),
      type
    ]
  );

  return result.rowCount > 0;
}

async function getPlayerType(name) {
  const result = await db.query(
    `
    SELECT type
    FROM tracked_players
    WHERE LOWER(name) = LOWER($1)
    LIMIT 1
    `,
    [name]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].type;
}

async function getTrackedPlayers(type) {
  const result = await db.query(
    `
    SELECT name
    FROM tracked_players
    WHERE type = $1
    ORDER BY LOWER(name)
    `,
    [type]
  );

  return result.rows;
}

// ==========================================
// MINECRAFT
// ==========================================

let mcBot = null;

let reconnectTimer = null;
let leaveTimer = null;

let intentionalLeave = false;
let verificationDetected = false;

// ==========================================
// VERIFICATION DETECTION
// ==========================================

function checkForVerification(message) {
  if (!message) return;

  const text = String(message);
  const lower = text.toLowerCase();

  const keywords = [
    'captcha',
    'verify',
    'verification',
    'проверка',
    'антибот',
    'анти-бот',
    'подтвердите',
    'подтверди'
  ];

  const detected =
    keywords.some(
      keyword => lower.includes(keyword)
    );

  if (!detected) {
    return;
  }

  const urls =
    text.match(
      /https?:\/\/[^\s<>()]+/gi
    ) || [];

  verificationDetected = true;
  intentionalLeave = true;

  console.log(
    '⚠️ Обнаружена возможная проверка MineBlaze'
  );

  if (urls.length > 0) {

    sendDiscord(
      `🚨 **MineBlaze запросил проверку бота!**\n\n` +
      `🔗 ${urls.join('\n')}\n\n` +
      `После проверки используй **/reconnect**.`
    );

  } else {

    sendDiscord(
      `🚨 **MineBlaze запросил проверку бота!**\n\n` +
      `Сообщение сервера:\n` +
      `\`\`\`\n${text.slice(0, 1500)}\n\`\`\`\n` +
      `После проверки используй **/reconnect**.`
    );
  }
}

// ==========================================
// TAB
// ==========================================

async function getTabText() {

  if (!mcBot || !mcBot.players) {
    return '❌ Minecraft бот сейчас не подключен.';
  }

  const players =
    Object.values(mcBot.players)
      .filter(
        player =>
          player &&
          player.username
      );

  const friends = [];
  const enemies = [];
  const normalPlayers = [];

  for (const player of players) {

    const type =
      await getPlayerType(
        player.username
      );

    if (type === 'friend') {

      friends.push(player);

    } else if (type === 'enemy') {

      enemies.push(player);

    } else {

      normalPlayers.push(player);
    }
  }

  const sortPlayers = list => {

    list.sort(
      (a, b) =>
        a.username.localeCompare(
          b.username,
          undefined,
          {
            sensitivity: 'base'
          }
        )
    );
  };

  sortPlayers(friends);
  sortPlayers(enemies);
  sortPlayers(normalPlayers);

  let text = '';

  // ========================================
  // HEADER
  // ========================================

  text += '👑 MineBlaze TAB\n';

  text +=
    `👥 Игроков: ${players.length}\n`;

  text +=
    '━━━━━━━━━━━━━━━━━━━━\n\n';

  // ========================================
  // FRIENDS
  // ========================================

  text +=
    `🟢 FRIENDS (${friends.length})\n`;

  if (friends.length === 0) {

    text +=
      '— нет друзей онлайн\n';

  } else {

    for (const player of friends) {

      const ping =
        Number.isFinite(player.ping)
          ? player.ping
          : 0;

      text +=
        `🟢 ${player.username}  |  ${ping} ms\n`;
    }
  }

  text += '\n';

  // ========================================
  // ENEMIES
  // ========================================

  text +=
    `🔴 ENEMIES (${enemies.length})\n`;

  if (enemies.length === 0) {

    text +=
      '— врагов онлайн нет\n';

  } else {

    for (const player of enemies) {

      const ping =
        Number.isFinite(player.ping)
          ? player.ping
          : 0;

      text +=
        `🔴 ${player.username}  |  ${ping} ms\n`;
    }
  }

  text += '\n';

  // ========================================
  // PLAYERS
  // ========================================

  text +=
    `🔵 PLAYERS (${normalPlayers.length})\n`;

  for (const player of normalPlayers) {

    const ping =
      Number.isFinite(player.ping)
        ? player.ping
        : 0;

    text +=
      `👤 ${player.username}  |  ${ping} ms\n`;
  }

  return text;
}

// ==========================================
// CONNECT MINECRAFT
// ==========================================

function connectMinecraft() {

  if (mcBot) {

    try {
      mcBot.quit();
    } catch {}

    mcBot = null;
  }

  clearTimeout(reconnectTimer);
  clearTimeout(leaveTimer);

  verificationDetected = false;

  console.log(
    `🔌 Подключение к ` +
    `${MINECRAFT_HOST}:${MINECRAFT_PORT}...`
  );

  mcBot = mineflayer.createBot({

    host: MINECRAFT_HOST,

    port: MINECRAFT_PORT,

    username: MINECRAFT_USERNAME,

    version: MINECRAFT_VERSION,

    auth: 'offline'
  });

  // ========================================
  // SPAWN
  // ========================================

  mcBot.once('spawn', async () => {

    console.log(
      '✅ Minecraft бот вошёл на сервер'
    );

    intentionalLeave = false;

    await sendDiscord(
      '🟢 **Minecraft бот вошёл на MineBlaze.**'
    );

    // ======================================
    // LOGIN
    // ======================================

    if (SERVER_PASSWORD) {

      setTimeout(() => {

        try {

          mcBot.chat(
            `/login ${SERVER_PASSWORD}`
          );

          console.log(
            '🔐 Отправлена команда /login'
          );

        } catch {}
      }, 2500);
    }

    // ======================================
    // KITPVP 2
    // ======================================

    setTimeout(() => {

      try {

        mcBot.chat('/kp2');

        console.log(
          '⚔️ Отправлена команда /kp2'
        );

      } catch {}

    }, 5000);

    // ======================================
    // 10 MINUTES
    // ======================================

    leaveTimer =
      setTimeout(
        async () => {

          if (!mcBot) {
            return;
          }

          intentionalLeave = true;

          await sendDiscord(
            '⏰ **Прошло 10 минут.**\n' +
            'Minecraft бот выходит с MineBlaze.\n\n' +
            'Для повторного входа используй **/reconnect**.'
          );

          try {
            mcBot.quit();
          } catch {}

        },
        10 * 60 * 1000
      );
  });

  // ========================================
  // MINECRAFT CHAT
  // ========================================

  mcBot.on(
    'message',
    jsonMsg => {

      const text =
        jsonMsg.toString();

      console.log(
        '[MC]',
        text
      );

      checkForVerification(text);
    }
  );

  // ========================================
  // KICK
  // ========================================

  mcBot.on(
    'kicked',
    reason => {

      console.log(
        '❌ Minecraft бот кикнут:',
        reason
      );

      const reasonText =
        typeof reason === 'string'
          ? reason
          : JSON.stringify(reason);

      checkForVerification(
        reasonText
      );
    }
  );

  // ========================================
  // ERROR
  // ========================================

  mcBot.on(
    'error',
    err => {

      console.error(
        '❌ Minecraft ошибка:',
        err.message
      );
    }
  );

  // ========================================
  // END
  // ========================================

  mcBot.on(
    'end',
    () => {

      console.log(
        '🔌 Minecraft соединение закрыто'
      );

      clearTimeout(leaveTimer);

      mcBot = null;

      // Специальный выход
      if (
        intentionalLeave ||
        verificationDetected
      ) {

        console.log(
          '🛑 Автопереподключение отключено'
        );

        return;
      }

      // Неожиданное отключение
      console.log(
        '🔄 Повторное подключение через 5 секунд...'
      );

      reconnectTimer =
        setTimeout(
          () => {
            connectMinecraft();
          },
          5000
        );
    }
  );
}

// ==========================================
// SLASH COMMANDS
// ==========================================

const commands = [

  // /kp2
  new SlashCommandBuilder()
    .setName('kp2')
    .setDescription(
      'Перейти в KitPvP 2'
    ),

  // /tab
  new SlashCommandBuilder()
    .setName('tab')
    .setDescription(
      'Показать TAB MineBlaze'
    ),

  // /reconnect
  new SlashCommandBuilder()
    .setName('reconnect')
    .setDescription(
      'Переподключить Minecraft бота'
    ),

  // /friendadd
  new SlashCommandBuilder()
    .setName('friendadd')
    .setDescription(
      'Добавить игрока в друзья'
    )
    .addStringOption(option =>
      option
        .setName('ник')
        .setDescription(
          'Ник игрока'
        )
        .setRequired(true)
    ),

  // /friendremove
  new SlashCommandBuilder()
    .setName('friendremove')
    .setDescription(
      'Удалить игрока из друзей'
    )
    .addStringOption(option =>
      option
        .setName('ник')
        .setDescription(
          'Ник игрока'
        )
        .setRequired(true)
    ),

  // /friends
  new SlashCommandBuilder()
    .setName('friends')
    .setDescription(
      'Показать список друзей'
    ),

  // /enemyadd
  new SlashCommandBuilder()
    .setName('enemyadd')
    .setDescription(
      'Добавить игрока во враги'
    )
    .addStringOption(option =>
      option
        .setName('ник')
        .setDescription(
          'Ник игрока'
        )
        .setRequired(true)
    ),

  // /enemyremove
  new SlashCommandBuilder()
    .setName('enemyremove')
    .setDescription(
      'Удалить игрока из врагов'
    )
    .addStringOption(option =>
      option
        .setName('ник')
        .setDescription(
          'Ник игрока'
        )
        .setRequired(true)
    ),

  // /enemies
  new SlashCommandBuilder()
    .setName('enemies')
    .setDescription(
      'Показать список врагов'
    )

].map(
  command => command.toJSON()
);

// ==========================================
// REGISTER COMMANDS
// ==========================================

async function registerCommands() {

  const rest =
    new REST({
      version: '10'
    })
      .setToken(
        DISCORD_TOKEN
      );

  await rest.put(

    Routes.applicationCommands(
      DISCORD_CLIENT_ID
    ),

    {
      body: commands
    }
  );

  console.log(
    '✅ Slash-команды зарегистрированы'
  );
}

// ==========================================
// DISCORD READY
// ==========================================

discord.once(
  'ready',
  () => {

    console.log(
      `🤖 Discord бот запущен: ` +
      `${discord.user.tag}`
    );
  }
);

// ==========================================
// DISCORD COMMANDS
// ==========================================

discord.on(
  'interactionCreate',
  async interaction => {

    if (!interaction.isChatInputCommand()) {
      return;
    }

    const command =
      interaction.commandName;

    // ======================================
    // /kp2
    // ======================================

    if (command === 'kp2') {

      if (!mcBot) {

        return interaction.reply(
          '❌ Minecraft бот сейчас не подключен.'
        );
      }

      try {

        mcBot.chat('/kp2');

        return interaction.reply(
          '⚔️ Команда `/kp2` отправлена.'
        );

      } catch {

        return interaction.reply(
          '❌ Не удалось отправить `/kp2`.'
        );
      }
    }

    // ======================================
    // /tab
    // ======================================

    if (command === 'tab') {

      if (!mcBot) {

        return interaction.reply(
          '❌ Minecraft бот сейчас не подключен.'
        );
      }

      await interaction.deferReply();

      try {

        const tab =
          await getTabText();

        /*
         * Discord ограничивает
         * обычное сообщение 2000 символами.
         */

        const chunks = [];

        let current = '';

        for (
          const line of tab.split('\n')
        ) {

          if (
            (current + line + '\n').length
            > 1900
          ) {

            if (current.length > 0) {
              chunks.push(current);
            }

            current =
              line + '\n';

          } else {

            current +=
              line + '\n';
          }
        }

        if (current.length > 0) {
          chunks.push(current);
        }

        if (chunks.length === 0) {

          return interaction.editReply(
            '❌ TAB пуст.'
          );
        }

        // Первую часть отправляем как ответ
        await interaction.editReply(
          `\`\`\`\n${chunks[0]}\`\`\``
        );

        // Остальные части отдельными сообщениями
        for (
          let i = 1;
          i < chunks.length;
          i++
        ) {

          await interaction.followUp(
            `\`\`\`\n${chunks[i]}\`\`\``
          );
        }

      } catch (err) {

        console.error(
          '❌ Ошибка /tab:',
          err
        );

        if (
          interaction.deferred
        ) {

          await interaction.editReply(
            '❌ Не удалось получить TAB.'
          );
        }
      }

      return;
    }

    // ======================================
    // /reconnect
    // ======================================

    if (command === 'reconnect') {

      await interaction.deferReply();

      intentionalLeave = false;
      verificationDetected = false;

      clearTimeout(
        reconnectTimer
      );

      clearTimeout(
        leaveTimer
      );

      if (mcBot) {

        try {
          mcBot.quit();
        } catch {}

        mcBot = null;
      }

      await interaction.editReply(
        '🔄 Переподключение к MineBlaze через 2 секунды...'
      );

      setTimeout(
        () => {
          connectMinecraft();
        },
        2000
      );

      return;
    }

    // ======================================
    // /friendadd
    // ======================================

    if (command === 'friendadd') {

      const name =
        interaction.options.getString(
          'ник'
        );

      try {

        await addTrackedPlayer(
          name,
          'friend'
        );

        return interaction.reply(
          `🟢 **${name}** добавлен в друзья.`
        );

      } catch (err) {

        console.error(err);

        return interaction.reply(
          '❌ Не удалось добавить игрока.'
        );
      }
    }

    // ======================================
    // /friendremove
    // ======================================

    if (command === 'friendremove') {

      const name =
        interaction.options.getString(
          'ник'
        );

      const removed =
        await removeTrackedPlayer(
          name,
          'friend'
        );

      if (!removed) {

        return interaction.reply(
          `❌ **${name}** не найден в друзьях.`
        );
      }

      return interaction.reply(
        `🗑️ **${name}** удалён из друзей.`
      );
    }

    // ======================================
    // /friends
    // ======================================

    if (command === 'friends') {

      const rows =
        await getTrackedPlayers(
          'friend'
        );

      if (rows.length === 0) {

        return interaction.reply(
          '🟢 Список друзей пуст.'
        );
      }

      const list =
        rows
          .map(
            row =>
              `🟢 ${row.name}`
          )
          .join('\n');

      return interaction.reply(
        `**🟢 Друзья (${rows.length})**\n${list}`
      );
    }

    // ======================================
    // /enemyadd
    // ======================================

    if (command === 'enemyadd') {

      const name =
        interaction.options.getString(
          'ник'
        );

      try {

        await addTrackedPlayer(
          name,
          'enemy'
        );

        return interaction.reply(
          `🔴 **${name}** добавлен во враги.`
        );

      } catch (err) {

        console.error(err);

        return interaction.reply(
          '❌ Не удалось добавить игрока.'
        );
      }
    }

    // ======================================
    // /enemyremove
    // ======================================

    if (command === 'enemyremove') {

      const name =
        interaction.options.getString(
          'ник'
        );

      const removed =
        await removeTrackedPlayer(
          name,
          'enemy'
        );

      if (!removed) {

        return interaction.reply(
          `❌ **${name}** не найден во врагах.`
        );
      }

      return interaction.reply(
        `🗑️ **${name}** удалён из врагов.`
      );
    }

    // ======================================
    // /enemies
    // ======================================

    if (command === 'enemies') {

      const rows =
        await getTrackedPlayers(
          'enemy'
        );

      if (rows.length === 0) {

        return interaction.reply(
          '🔴 Список врагов пуст.'
        );
      }

      const list =
        rows
          .map(
            row =>
              `🔴 ${row.name}`
          )
          .join('\n');

      return interaction.reply(
        `**🔴 Враги (${rows.length})**\n${list}`
      );
    }
  }
);

// ==========================================
// START
// ==========================================

async function start() {

  try {

    await initDatabase();

    await registerCommands();

    await discord.login(
      DISCORD_TOKEN
    );

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
