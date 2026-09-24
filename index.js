const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');

const mineflayer = require('mineflayer');
const { Pool } = require('pg');
const http = require('http');

/* =========================================================
   ENV
========================================================= */

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,

  CHANNEL_ID,
  CHANNEL_ID_2,

  MINECRAFT_HOST,
  MINECRAFT_PORT,
  MINECRAFT_USERNAME,
  MINECRAFT_VERSION,
  SERVER_PASSWORD,

  DATABASE_URL,

  PORT
} = process.env;


/* =========================================================
   ENV CHECK
========================================================= */

const requiredEnv = {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,

  CHANNEL_ID,

  MINECRAFT_HOST,
  MINECRAFT_PORT,
  MINECRAFT_USERNAME,
  MINECRAFT_VERSION,

  DATABASE_URL
};

for (const [name, value] of Object.entries(requiredEnv)) {
  if (!value) {
    throw new Error(
      `❌ Не указана переменная окружения: ${name}`
    );
  }
}


/* =========================================================
   RENDER HTTP SERVER
========================================================= */

const HTTP_PORT = Number(PORT) || 10000;

const server = http.createServer((req, res) => {

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8'
  });

  res.end('Unity bot is online');

});

server.listen(
  HTTP_PORT,
  '0.0.0.0',
  () => {

    console.log(
      `🌐 HTTP сервер запущен на 0.0.0.0:${HTTP_PORT}`
    );

  }
);


/* =========================================================
   POSTGRESQL
========================================================= */

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
      type TEXT NOT NULL
        CHECK (type IN ('friend', 'enemy')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log('✅ PostgreSQL готов');

}


/* =========================================================
   DISCORD
========================================================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});


/* =========================================================
   MINECRAFT STATE
========================================================= */

let mcBot = null;

let isOnKp2 = false;

let connecting = false;

let shouldReconnect = true;

let reconnectTimer = null;

let autoLeaveTimer = null;


/* =========================================================
   DISCORD CHANNELS
========================================================= */

function getChannelIds() {

  return [
    CHANNEL_ID,
    CHANNEL_ID_2
  ].filter(Boolean);

}


/* =========================================================
   SLASH COMMANDS
========================================================= */

const commands = [

  new SlashCommandBuilder()
    .setName('kp2')
    .setDescription('Перейти в KitPvP 2'),

  new SlashCommandBuilder()
    .setName('tab')
    .setDescription('Показать игроков онлайн'),

  new SlashCommandBuilder()
    .setName('reconnect')
    .setDescription('Переподключить Minecraft бота'),

  new SlashCommandBuilder()
    .setName('friendadd')
    .setDescription('Добавить игрока в друзья')
    .addStringOption(option =>
      option
        .setName('nick')
        .setDescription('Ник игрока')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('friendremove')
    .setDescription('Удалить игрока из друзей')
    .addStringOption(option =>
      option
        .setName('nick')
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
        .setName('nick')
        .setDescription('Ник игрока')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('enemyremove')
    .setDescription('Удалить игрока из врагов')
    .addStringOption(option =>
      option
        .setName('nick')
        .setDescription('Ник игрока')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('enemies')
    .setDescription('Показать список врагов')

].map(command => command.toJSON());


/* =========================================================
   REGISTER COMMANDS
========================================================= */

async function registerCommands() {

  const rest = new REST({
    version: '10'
  }).setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationCommands(DISCORD_CLIENT_ID),
    {
      body: commands
    }
  );

  console.log(
    '✅ Slash-команды зарегистрированы'
  );

}


/* =========================================================
   SEND MESSAGE TO BOTH CHANNELS
========================================================= */

async function sendDiscordMessage(text) {

  if (!client.isReady()) {
    return;
  }

  const channelIds =
    getChannelIds();

  for (const channelId of channelIds) {

    try {

      const channel =
        await client.channels.fetch(
          channelId
        );

      if (!channel) {

        console.log(
          `❌ Канал ${channelId} не найден`
        );

        continue;
      }

      await channel.send(text);

    } catch (error) {

      console.log(
        `❌ Ошибка отправки в канал ${channelId}:`,
        error.message
      );

    }

  }

}


/* =========================================================
   TEXT CLEANER
========================================================= */

function cleanText(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return '';
  }

  return String(value)
    .replace(
      /\u001b\[[0-?]*[ -/]*[@-~]/g,
      ''
    )
    .replace(
      /§[0-9A-FK-OR]/gi,
      ''
    )
    .replace(
      /\s+/g,
      ' '
    )
    .trim();

}


/* =========================================================
   DATABASE HELPERS
========================================================= */

async function addTrackedPlayer(
  name,
  type
) {

  const cleanName =
    name.trim();

  await pool.query(
    `
    DELETE FROM tracked_players
    WHERE LOWER(name) = LOWER($1)
    `,
    [cleanName]
  );

  await pool.query(
    `
    INSERT INTO tracked_players
      (name, type)
    VALUES
      ($1, $2)
    `,
    [
      cleanName,
      type
    ]
  );

}


async function removeTrackedPlayer(
  name,
  type
) {

  const result =
    await pool.query(
      `
      DELETE FROM tracked_players
      WHERE LOWER(name) = LOWER($1)
        AND type = $2
      `,
      [
        name.trim(),
        type
      ]
    );

  return result.rowCount > 0;

}


async function getTrackedPlayers(
  type
) {

  const result =
    await pool.query(
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


async function getTrackedMap() {

  const result =
    await pool.query(
      `
      SELECT name, type
      FROM tracked_players
      `
    );

  const map = new Map();

  for (const row of result.rows) {

    map.set(
      row.name.toLowerCase(),
      row.type
    );

  }

  return map;

}


/* =========================================================
   COMMAND CHANNEL CHECK
========================================================= */

function isCorrectChannel(
  interaction
) {

  return (
    interaction.channelId === CHANNEL_ID ||
    interaction.channelId === CHANNEL_ID_2
  );

}


/* =========================================================
   CONNECT MINECRAFT
========================================================= */

function connectMinecraft() {

  if (connecting) {

    console.log(
      '⚠️ Minecraft подключение уже выполняется'
    );

    return;

  }


  if (mcBot) {

    console.log(
      '⚠️ Minecraft бот уже подключён'
    );

    return;

  }


  connecting = true;

  isOnKp2 = false;


  console.log(
    `🔌 Подключение к ${MINECRAFT_HOST}:${MINECRAFT_PORT}...`
  );


  let bot;


  try {

    bot = mineflayer.createBot({

      host: MINECRAFT_HOST,

      port:
        Number(MINECRAFT_PORT),

      username:
        MINECRAFT_USERNAME,

      version:
        MINECRAFT_VERSION

    });

  } catch (error) {

    connecting = false;

    console.log(
      '❌ Ошибка создания Minecraft бота:',
      error.message
    );

    scheduleReconnect();

    return;

  }


  mcBot = bot;

  connecting = false;


  /* =======================================================
     SPAWN
  ======================================================= */

  bot.once(
    'spawn',
    async () => {

      console.log(
        '✅ Minecraft бот вошёл на сервер'
      );


      await sendDiscordMessage(
        '🟢 **Minecraft бот вошёл на сервер.**'
      );


      /* -----------------------------------------------------
         LOGIN
      ----------------------------------------------------- */

      if (SERVER_PASSWORD) {

        setTimeout(() => {

          if (!mcBot) {
            return;
          }

          try {

            mcBot.chat(
              `/login ${SERVER_PASSWORD}`
            );

            console.log(
              '🔐 Отправлена команда /login'
            );

          } catch (error) {

            console.log(
              '❌ Ошибка /login:',
              error.message
            );

          }

        }, 1500);

      }


      /* -----------------------------------------------------
         AUTOMATIC KP2
      ----------------------------------------------------- */

      setTimeout(() => {

        if (!mcBot) {
          return;
        }

        try {

          mcBot.chat('/kp2');

          console.log(
            '⚔️ Автоматически отправлена команда /kp2'
          );

          isOnKp2 = true;

        } catch (error) {

          console.log(
            '❌ Ошибка /kp2:',
            error.message
          );

        }

      }, 6000);


      /* -----------------------------------------------------
         AUTO LEAVE 10 MINUTES
      ----------------------------------------------------- */

      clearTimeout(
        autoLeaveTimer
      );


      autoLeaveTimer =
        setTimeout(
          async () => {

            if (!mcBot) {
              return;
            }

            console.log(
              '⏰ Прошло 10 минут. Minecraft бот выходит.'
            );


            await sendDiscordMessage(
              '⏰ **Прошло 10 минут.**\nMinecraft бот выходит с MineBlaze.\n\nДля повторного входа используй `/reconnect`.'
            );


            shouldReconnect = false;

            isOnKp2 = false;


            const oldBot =
              mcBot;

            mcBot = null;


            try {

              oldBot.quit(
                '10 minutes'
              );

            } catch (error) {

              console.log(
                'Ошибка выхода:',
                error.message
              );

            }

          },
          10 * 60 * 1000
        );

    }
  );


  /* =======================================================
     MINECRAFT MESSAGES
  ======================================================= */

  bot.on(
    'message',
    async message => {

      const text =
        cleanText(
          message.toString()
        );


      if (!text) {
        return;
      }


      console.log(
        `[MC] ${text}`
      );


      const lower =
        text.toLowerCase();


      /* -----------------------------------------------------
         VERIFICATION
      ----------------------------------------------------- */

      const verificationDetected =
        lower.includes('captcha') ||
        lower.includes('капч') ||
        lower.includes('verification') ||
        lower.includes('верификац') ||
        (
          lower.includes('проверка') &&
          lower.includes('бот')
        );


      if (verificationDetected) {

        const urls =
          text.match(
            /https?:\/\/[^\s]+/gi
          ) || [];


        console.log(
          '⚠️ Обнаружена проверка MineBlaze'
        );


        let notification =
          '⚠️ **MineBlaze запросил проверку.**\n';


        if (urls.length > 0) {

          notification +=
            '\n' +
            urls.join('\n');

        } else {

          notification +=
            '\nСсылка на проверку не найдена.';

        }


        await sendDiscordMessage(
          notification
        );


        shouldReconnect = false;

        isOnKp2 = false;


        try {

          bot.quit(
            'Verification required'
          );

        } catch (error) {

          console.log(
            'Ошибка выхода после проверки:',
            error.message
          );

        }

      }

    }
  );


  /* =======================================================
     KICK
  ======================================================= */

  bot.on(
    'kicked',
    reason => {

      console.log(
        '⚠️ Minecraft бот кикнут:',
        cleanText(reason)
      );

    }
  );


  /* =======================================================
     ERROR
  ======================================================= */

  bot.on(
    'error',
    error => {

      console.log(
        '❌ Minecraft ошибка:',
        error.message
      );

    }
  );


  /* =======================================================
     END
  ======================================================= */

  bot.on(
    'end',
    reason => {

      console.log(
        '🔌 Minecraft соединение закрыто:',
        cleanText(reason)
      );


      clearTimeout(
        autoLeaveTimer
      );


      isOnKp2 = false;


      if (mcBot === bot) {
        mcBot = null;
      }


      if (shouldReconnect) {

        scheduleReconnect();

      } else {

        console.log(
          '🛑 Автоматический реконнект отключён.'
        );

      }

    }
  );

}


/* =========================================================
   AUTOMATIC RECONNECT
========================================================= */

function scheduleReconnect() {

  if (!shouldReconnect) {
    return;
  }


  if (reconnectTimer) {
    return;
  }


  console.log(
    '🔄 Повторное подключение через 5 секунд...'
  );


  reconnectTimer =
    setTimeout(
      () => {

        reconnectTimer = null;


        if (!shouldReconnect) {
          return;
        }


        connectMinecraft();

      },
      5000
    );

}


/* =========================================================
   MANUAL RECONNECT
========================================================= */

async function reconnectMinecraft() {

  clearTimeout(
    reconnectTimer
  );

  reconnectTimer = null;


  clearTimeout(
    autoLeaveTimer
  );

  autoLeaveTimer = null;


  shouldReconnect = false;

  isOnKp2 = false;


  const oldBot =
    mcBot;

  mcBot = null;


  if (oldBot) {

    try {

      oldBot.quit(
        'Manual reconnect'
      );

    } catch (error) {

      console.log(
        'Ошибка закрытия старого соединения:',
        error.message
      );

    }

  }


  await new Promise(
    resolve =>
      setTimeout(
        resolve,
        2000
      )
  );


  shouldReconnect = true;


  connectMinecraft();


  /* -------------------------------------------------------
     Ждём Minecraft
  ------------------------------------------------------- */

  for (
    let i = 0;
    i < 30;
    i++
  ) {

    if (mcBot) {
      break;
    }

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          500
        )
    );

  }


  /* -------------------------------------------------------
     Ждём LOGIN + KP2
  ------------------------------------------------------- */

  await new Promise(
    resolve =>
      setTimeout(
        resolve,
        8000
      )
  );


  return !!mcBot;

}


/* =========================================================
   TAB
========================================================= */

async function getTabText() {

  if (!mcBot) {

    return (
      '❌ Minecraft бот сейчас не подключён.'
    );

  }


  const tracked =
    await getTrackedMap();


  const players =
    Object.values(
      mcBot.players || {}
    )
      .filter(
        player =>
          player &&
          player.username
      )
      .filter(
        player =>
          !/staff\s+in\s+vanish/i.test(
            player.username
          )
      );


  if (players.length === 0) {

    return (
      '📋 На сервере игроков не найдено.'
    );

  }


  const lines = [];


  for (const player of players) {

    const name =
      player.username;


    const type =
      tracked.get(
        name.toLowerCase()
      );


    let icon = '⚪';


    if (type === 'friend') {
      icon = '🟢';
    }


    if (type === 'enemy') {
      icon = '🔴';
    }


    const ping =
      Number.isFinite(
        player.ping
      )
        ? `${player.ping} ms`
        : '—';


    lines.push(
      `${icon} | ${name} | ${ping}`
    );

  }


  lines.sort(
    (a, b) =>
      a.localeCompare(
        b,
        undefined,
        {
          sensitivity: 'base'
        }
      )
  );


  return lines.join('\n');

}


/* =========================================================
   SPLIT DISCORD MESSAGE
========================================================= */

function splitText(
  text,
  maxLength = 1900
) {

  const lines =
    text.split('\n');


  const chunks = [];

  let current = '';


  for (const line of lines) {

    if (
      current.length +
      line.length +
      1 >
      maxLength
    ) {

      if (current) {
        chunks.push(current);
      }

      current = line;

    } else {

      current +=
        (current ? '\n' : '') +
        line;

    }

  }


  if (current) {
    chunks.push(current);
  }


  return chunks;

}


/* =========================================================
   DISCORD INTERACTIONS
========================================================= */

client.on(
  'interactionCreate',
  async interaction => {

    if (
      !interaction.isChatInputCommand()
    ) {
      return;
    }


    try {

      /* ---------------------------------------------------
         CHANNEL CHECK
      --------------------------------------------------- */

      if (
        !isCorrectChannel(
          interaction
        )
      ) {

        await interaction.reply({
          content:
            `❌ Используй команды в одном из разрешённых каналов.`,
          ephemeral: true
        });

        return;

      }


      /* ===================================================
         /KP2
      =================================================== */

      if (
        interaction.commandName === 'kp2'
      ) {

        if (!mcBot) {

          await interaction.reply(
            '❌ Minecraft бот сейчас не подключён.'
          );

          return;

        }


        mcBot.chat('/kp2');

        isOnKp2 = true;


        await interaction.reply(
          '⚔️ Команда `/kp2` отправлена.'
        );


        return;

      }


      /* ===================================================
         /RECONNECT
      =================================================== */

      if (
        interaction.commandName === 'reconnect'
      ) {

        await interaction.deferReply();


        console.log(
          '🔄 Запущен ручной реконнект.'
        );


        const connected =
          await reconnectMinecraft();


        if (connected) {

          await interaction.editReply(
            '✅ Minecraft переподключён и отправлен на КП2.'
          );

        } else {

          await interaction.editReply(
            '❌ Minecraft не удалось подключить.'
          );

        }


        return;

      }


      /* ===================================================
         /TAB
      =================================================== */

      if (
        interaction.commandName === 'tab'
      ) {

        await interaction.deferReply();


        try {

          /*
           * БОТ УЖЕ НА КП2
           *
           * НИКАКОГО RECONNECT.
           */

          if (
            mcBot &&
            isOnKp2
          ) {

            console.log(
              '📋 /tab: бот уже на КП2. Реконнект не нужен.'
            );

          } else {

            /*
             * Minecraft отключён
             */

            if (!mcBot) {

              console.log(
                '📋 /tab: Minecraft отключён. Подключаю...'
              );


              shouldReconnect = true;


              connectMinecraft();


              /*
               * Ждём подключения
               */

              for (
                let i = 0;
                i < 30;
                i++
              ) {

                if (mcBot) {
                  break;
                }


                await new Promise(
                  resolve =>
                    setTimeout(
                      resolve,
                      500
                    )
                );

              }


              if (!mcBot) {

                await interaction.editReply(
                  '❌ Minecraft бот не смог подключиться.'
                );

                return;

              }


              /*
               * Ждём LOGIN + KP2
               */

              await new Promise(
                resolve =>
                  setTimeout(
                    resolve,
                    8000
                  )
              );

            }


            /*
             * Бот подключён,
             * но ещё не на КП2.
             */

            if (
              mcBot &&
              !isOnKp2
            ) {

              console.log(
                '⚔️ /tab: отправляю /kp2.'
              );


              mcBot.chat(
                '/kp2'
              );


              isOnKp2 = true;


              await new Promise(
                resolve =>
                  setTimeout(
                    resolve,
                    3000
                  )
              );

            }

          }


          /* ------------------------------------------------
             Получаем TAB
          ------------------------------------------------ */

          const text =
            await getTabText();


          const chunks =
            splitText(text);


          await interaction.editReply(
            `\`\`\`text\n${chunks[0]}\n\`\`\``
          );


          for (
            let i = 1;
            i < chunks.length;
            i++
          ) {

            await interaction.followUp(
              `\`\`\`text\n${chunks[i]}\n\`\`\``
            );

          }

        } catch (error) {

          console.log(
            '❌ Ошибка /tab:',
            error.message
          );


          await interaction.editReply(
            '❌ Не удалось получить список игроков.'
          );

        }


        return;

      }


      /* ===================================================
         /FRIENDADD
      =================================================== */

      if (
        interaction.commandName === 'friendadd'
      ) {

        const nick =
          interaction.options.getString(
            'nick',
            true
          );


        await addTrackedPlayer(
          nick,
          'friend'
        );


        await interaction.reply(
          `🟢 **${nick}** добавлен в друзья.`
        );


        return;

      }


      /* ===================================================
         /FRIENDREMOVE
      =================================================== */

      if (
        interaction.commandName === 'friendremove'
      ) {

        const nick =
          interaction.options.getString(
            'nick',
            true
          );


        const removed =
          await removeTrackedPlayer(
            nick,
            'friend'
          );


        if (removed) {

          await interaction.reply(
            `🗑️ **${nick}** удалён из друзей.`
          );

        } else {

          await interaction.reply(
            `❌ **${nick}** не найден в списке друзей.`
          );

        }


        return;

      }


      /* ===================================================
         /FRIENDS
      =================================================== */

      if (
        interaction.commandName === 'friends'
      ) {

        const friends =
          await getTrackedPlayers(
            'friend'
          );


        if (
          friends.length === 0
        ) {

          await interaction.reply(
            '🟢 Список друзей пуст.'
          );

          return;

        }


        const text =
          friends
            .map(
              row =>
                `🟢 ${row.name}`
            )
            .join('\n');


        await interaction.reply(
          `**🟢 Друзья (${friends.length})**\n${text}`
        );


        return;

      }


      /* ===================================================
         /ENEMYADD
      =================================================== */

      if (
        interaction.commandName === 'enemyadd'
      ) {

        const nick =
          interaction.options.getString(
            'nick',
            true
          );


        await addTrackedPlayer(
          nick,
          'enemy'
        );


        await interaction.reply(
          `🔴 **${nick}** добавлен во враги.`
        );


        return;

      }


      /* ===================================================
         /ENEMYREMOVE
      =================================================== */

      if (
        interaction.commandName === 'enemyremove'
      ) {

        const nick =
          interaction.options.getString(
            'nick',
            true
          );


        const removed =
          await removeTrackedPlayer(
            nick,
            'enemy'
          );


        if (removed) {

          await interaction.reply(
            `🗑️ **${nick}** удалён из врагов.`
          );

        } else {

          await interaction.reply(
            `❌ **${nick}** не найден в списке врагов.`
          );

        }


        return;

      }


      /* ===================================================
         /ENEMIES
      =================================================== */

      if (
        interaction.commandName === 'enemies'
      ) {

        const enemies =
          await getTrackedPlayers(
            'enemy'
          );


        if (
          enemies.length === 0
        ) {

          await interaction.reply(
            '🔴 Список врагов пуст.'
          );

          return;

        }


        const text =
          enemies
            .map(
              row =>
                `🔴 ${row.name}`
            )
            .join('\n');


        await interaction.reply(
          `**🔴 Враги (${enemies.length})**\n${text}`
        );


        return;

      }

    } catch (error) {

      console.log(
        '❌ Ошибка Discord команды:',
        error.message
      );


      try {

        if (
          interaction.deferred
        ) {

          await interaction.editReply(
            '❌ Произошла ошибка при выполнении команды.'
          );

        } else if (
          !interaction.replied
        ) {

          await interaction.reply({
            content:
              '❌ Произошла ошибка при выполнении команды.',
            ephemeral: true
          });

        }

      } catch (_) {
        // ignore
      }

    }

  }
);


/* =========================================================
   DISCORD READY
========================================================= */

client.once(
  'clientReady',
  discordClient => {

    console.log(
      `🤖 Discord бот запущен: ${discordClient.user.tag}`
    );

  }
);


/* =========================================================
   START
========================================================= */

async function start() {

  try {

    await initDatabase();

    await registerCommands();

    await client.login(
      DISCORD_TOKEN
    );

    connectMinecraft();

  } catch (error) {

    console.error(
      '❌ Критическая ошибка запуска:',
      error
    );

    process.exit(1);

  }

}

start();


/* =========================================================
   SHUTDOWN
========================================================= */

async function shutdown(
  signal
) {

  console.log(
    `🛑 Получен ${signal}. Останавливаем бота...`
  );


  shouldReconnect = false;


  clearTimeout(
    reconnectTimer
  );


  clearTimeout(
    autoLeaveTimer
  );


  if (mcBot) {

    try {

      mcBot.quit(
        'Process shutdown'
      );

    } catch (_) {
      // ignore
    }


    mcBot = null;

  }


  try {
    await pool.end();
  } catch (_) {
    // ignore
  }


  try {
    client.destroy();
  } catch (_) {
    // ignore
  }


  server.close(
    () => {
      process.exit(0);
    }
  );


  setTimeout(
    () => process.exit(0),
    5000
  );

}


process.on(
  'SIGINT',
  () => shutdown('SIGINT')
);


process.on(
  'SIGTERM',
  () => shutdown('SIGTERM')
);
