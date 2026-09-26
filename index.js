const {
  Client,
  GatewayIntentBits
} = require('discord.js');

const mineflayer = require('mineflayer');
const { Pool } = require('pg');
const sharp = require('sharp');
const http = require('http');


/* =========================================================
   ENV
========================================================= */

const {
  DISCORD_TOKEN,

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
   HTTP SERVER FOR RENDER
========================================================= */

const HTTP_PORT =
  Number(PORT) || 10000;

const server = http.createServer(
  (req, res) => {

    res.writeHead(200, {
      'Content-Type':
        'text/plain; charset=utf-8'
    });

    res.end(
      'Unity bot is online'
    );

  }
);

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
  connectionString:
    DATABASE_URL,

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

  console.log(
    '✅ PostgreSQL готов'
  );

}


/* =========================================================
   DISCORD
========================================================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
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
   SEND MESSAGE TO BOTH CHANNELS
========================================================= */

async function sendDiscordMessage(text) {

  if (!client.isReady()) {
    return;
  }

  for (const channelId of getChannelIds()) {

    try {

      const channel =
        await client.channels.fetch(
          channelId
        );

      if (!channel) {

        console.log(
          `❌ Discord канал ${channelId} не найден`
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
   CLEAN TEXT
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
   XML ESCAPE
========================================================= */

function escapeXml(value) {

  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

}


/* =========================================================
   DATABASE
========================================================= */

async function addTrackedPlayer(
  name,
  type
) {

  const cleanName =
    name.trim();

  /*
   * Если игрок уже был Friend/enemy,
   * удаляем старую запись.
   */

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
   CHANNEL CHECK
========================================================= */

function isCorrectChannel(message) {

  return (
    message.channel.id === CHANNEL_ID ||
    message.channel.id === CHANNEL_ID_2
  );

}


/* =========================================================
   PING COLOR
========================================================= */

function getPingColor(ping) {

  if (!Number.isFinite(ping)) {
    return '#888888';
  }

  if (ping <= 80) {
    return '#00ff55';
  }

  if (ping <= 150) {
    return '#eaff00';
  }

  if (ping <= 250) {
    return '#ff9900';
  }

  return '#ff3333';

}


/* =========================================================
   FETCH MINECRAFT HEAD
========================================================= */

async function getPlayerHead(
  username
) {

  try {

    const url =
      `https://mc-heads.net/avatar/${encodeURIComponent(username)}/64`;

    const response =
      await fetch(url);

    if (!response.ok) {
      return null;
    }

    const arrayBuffer =
      await response.arrayBuffer();

    return Buffer.from(
      arrayBuffer
    );

  } catch (error) {

    console.log(
      `⚠️ Не удалось получить голову ${username}:`,
      error.message
    );

    return null;

  }

}


/* =========================================================
   CREATE SVG PLAYER HEAD
========================================================= */

async function headToDataUri(
  buffer
) {

  if (!buffer) {
    return null;
  }

  try {

    const png =
      await sharp(buffer)
        .resize(32, 32)
        .png()
        .toBuffer();

    return (
      'data:image/png;base64,' +
      png.toString('base64')
    );

  } catch (_) {

    return null;

  }

}


/* =========================================================
   SVG PLAYER ROW
========================================================= */

function createPlayerRow(
  player,
  x,
  y,
  width,
  type
) {

  const name =
    escapeXml(player.username);

  const ping =
    Number.isFinite(player.ping)
      ? player.ping
      : 0;

  const pingColor =
    getPingColor(ping);

  let nameColor =
    '#f2f2f2';

  if (type === 'friend') {
    nameColor = '#00ff55';
  }

  if (type === 'enemy') {
    nameColor = '#ff4444';
  }

  const head =
    player.headDataUri
      ? `
        <image
          href="${player.headDataUri}"
          x="${x}"
          y="${y - 22}"
          width="28"
          height="28"
          preserveAspectRatio="none"
        />
      `
      : `
        <rect
          x="${x}"
          y="${y - 22}"
          width="28"
          height="28"
          rx="5"
          fill="#222b28"
        />

        <text
          x="${x + 14}"
          y="${y - 3}"
          text-anchor="middle"
          font-size="14"
          fill="#ffffff"
          font-family="Arial, sans-serif"
        >
          ${escapeXml(player.username.charAt(0).toUpperCase())}
        </text>
      `;

  return `
    ${head}

    <text
      x="${x + 40}"
      y="${y}"
      font-size="20"
      fill="${nameColor}"
      font-family="Arial, sans-serif"
      font-weight="500"
    >
      ${name}
    </text>

    <text
      x="${x + width}"
      y="${y}"
      text-anchor="end"
      font-size="18"
      fill="${pingColor}"
      font-family="Arial, sans-serif"
      font-weight="600"
    >
      ${Number.isFinite(player.ping)
        ? `${ping}ms`
        : '—'}
    </text>
  `;

}


/* =========================================================
   SVG PANEL
========================================================= */

function createPanel(
  title,
  titleColor,
  players,
  x,
  y,
  width,
  height
) {

  let svg = `
    <rect
      x="${x}"
      y="${y}"
      width="${width}"
      height="${height}"
      rx="16"
      fill="#08110f"
      stroke="#174d35"
      stroke-width="2"
    />

    <text
      x="${x + 24}"
      y="${y + 38}"
      font-size="22"
      fill="${titleColor}"
      font-family="Arial, sans-serif"
      font-weight="700"
    >
      ${escapeXml(title)}
    </text>

    <line
      x1="${x + 24}"
      y1="${y + 54}"
      x2="${x + width - 24}"
      y2="${y + 54}"
      stroke="#143629"
      stroke-width="1"
    />
  `;


  if (players.length === 0) {

    svg += `
      <text
        x="${x + width / 2}"
        y="${y + 105}"
        text-anchor="middle"
        font-size="18"
        fill="#66736e"
        font-family="Arial, sans-serif"
      >
        No players
      </text>
    `;

    return svg;

  }


  const rowHeight = 43;

  const innerX =
    x + 24;

  const pingWidth =
    68;


  players.forEach(
    (player, index) => {

      const rowY =
        y +
        90 +
        index * rowHeight;


      svg +=
        createPlayerRow(
          player,
          innerX,
          rowY,
          width -
            48 -
            pingWidth,
          player.trackedType
        );

    }
  );


  return svg;

}


/* =========================================================
   CREATE TAB IMAGE
========================================================= */

async function createTabImage() {

  if (!mcBot) {
    throw new Error(
      'Minecraft бот не подключён'
    );
  }


  const tracked =
    await getTrackedMap();


  let players =
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


  /*
   * Добавляем тип игрока.
   */

  players =
    players.map(
      player => {

        const trackedType =
          tracked.get(
            player.username.toLowerCase()
          ) || null;

        return {
          username:
            player.username,

          ping:
            Number.isFinite(player.ping)
              ? player.ping
              : null,

          trackedType
        };

      }
    );


  /*
   * Загружаем головы.
   * Ошибка получения головы не ломает TAB.
   */

  await Promise.all(
    players.map(
      async player => {

        const image =
          await getPlayerHead(
            player.username
          );

        player.headDataUri =
          await headToDataUri(
            image
          );

      }
    )
  );


  /*
   * Разделяем игроков.
   */

  const friends =
    players.filter(
      player =>
        player.trackedType === 'friend'
    );


  const enemies =
    players.filter(
      player =>
        player.trackedType === 'enemy'
    );


  const normal =
    players.filter(
      player =>
        !player.trackedType
    );


  /*
   * Сортировка по имени.
   */

  const sortPlayers =
    list =>
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


  sortPlayers(friends);
  sortPlayers(normal);
  sortPlayers(enemies);


  /*
   * Средняя колонка может быть широкой.
   */

  const canvasWidth =
    1800;


  const padding = 24;

  const gap = 20;

  const leftWidth = 410;

  const rightWidth = 410;

  const centerWidth =
    canvasWidth -
    padding * 2 -
    gap * 2 -
    leftWidth -
    rightWidth;


  /*
   * Определяем необходимую высоту.
   */

  const largest =
    Math.max(
      friends.length,
      normal.length,
      enemies.length,
      1
    );


  const rowHeight = 43;

  const headerHeight = 145;

  const panelTop = 145;

  const panelPadding = 90;

  const minPanelHeight = 260;


  const panelHeight =
    Math.max(
      minPanelHeight,
      panelPadding +
        largest * rowHeight +
        45
    );


  const canvasHeight =
    panelTop +
    panelHeight +
    30;


  /*
   * SVG.
   */

  let svg = `

  <svg
    width="${canvasWidth}"
    height="${canvasHeight}"
    xmlns="http://www.w3.org/2000/svg"
  >

    <defs>

      <linearGradient
        id="background"
        x1="0"
        y1="0"
        x2="0"
        y2="1"
      >
        <stop
          offset="0%"
          stop-color="#05351f"
        />

        <stop
          offset="35%"
          stop-color="#061c13"
        />

        <stop
          offset="100%"
          stop-color="#070d0c"
        />
      </linearGradient>

    </defs>


    <rect
      width="100%"
      height="100%"
      fill="url(#background)"
    />


    <!-- STATUS -->

    <rect
      x="${canvasWidth / 2 - 75}"
      y="20"
      width="150"
      height="30"
      rx="15"
      fill="#123c29"
      stroke="#276344"
      stroke-width="1"
    />

    <circle
      cx="${canvasWidth / 2 - 57}"
      cy="35"
      r="5"
      fill="#00ff75"
    />

    <text
      x="${canvasWidth / 2 - 45}"
      y="41"
      font-size="15"
      fill="#d7e5de"
      font-family="Arial, sans-serif"
    >
      Online
    </text>


    <!-- TITLE -->

    <text
      x="${canvasWidth / 2}"
      y="88"
      text-anchor="middle"
      font-size="42"
      fill="#ffffff"
      font-family="Arial, sans-serif"
      font-weight="700"
    >
      MineBlaze — TAB
    </text>


    <!-- SUBTITLE -->

    <text
      x="${canvasWidth / 2}"
      y="115"
      text-anchor="middle"
      font-size="18"
      fill="#8ba79b"
      font-family="Arial, sans-serif"
    >
      Server: ${escapeXml(MINECRAFT_HOST)} • Players: ${players.length}
    </text>


    <!-- FRIEND -->

    ${createPanel(
      'Friend',
      '#00ff55',
      friends,
      padding,
      panelTop,
      leftWidth,
      panelHeight
    )}


    <!-- PLAYERS -->

    ${createPanel(
      'Players',
      '#ffffff',
      normal,
      padding +
        leftWidth +
        gap,
      panelTop,
      centerWidth,
      panelHeight
    )}


    <!-- ENEMY -->

    ${createPanel(
      'enemy',
      '#ff3333',
      enemies,
      canvasWidth -
        padding -
        rightWidth,
      panelTop,
      rightWidth,
      panelHeight
    )}

  </svg>
  `;


  /*
   * SVG → PNG
   */

  const buffer =
    await sharp(
      Buffer.from(svg)
    )
      .png()
      .toBuffer();


  return buffer;

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

    bot =
      mineflayer.createBot({

        host:
          MINECRAFT_HOST,

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


      /* LOGIN */

      if (SERVER_PASSWORD) {

        setTimeout(
          () => {

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

          },
          1500
        );

      }


      /* KP2 */

      setTimeout(
        () => {

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

        },
        6000
      );


      /* AUTO LEAVE */

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
              '⏰ **Прошло 10 минут.**\nMinecraft бот выходит с MineBlaze.\n\nДля повторного входа используй `#reconnect`.'
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
     MINECRAFT CHAT
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


      /*
       * Проверка CAPTCHA / verification.
       * Бот ничего не обходит.
       */

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


  /* KICK */

  bot.on(
    'kicked',
    reason => {

      console.log(
        '⚠️ Minecraft бот кикнут:',
        cleanText(reason)
      );

    }
  );


  /* ERROR */

  bot.on(
    'error',
    error => {

      console.log(
        '❌ Minecraft ошибка:',
        error.message
      );

    }
  );


  /* END */

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
   AUTO RECONNECT
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
   DISCORD COMMANDS
========================================================= */

client.on(
  'messageCreate',
  async message => {

    if (message.author.bot) {
      return;
    }


    if (!isCorrectChannel(message)) {
      return;
    }


    const content =
      message.content.trim();


    if (
      !content.startsWith('#')
    ) {
      return;
    }


    const parts =
      content
        .slice(1)
        .trim()
        .split(/\s+/);


    const command =
      parts
        .shift()
        ?.toLowerCase();


    const args =
      parts;


    if (!command) {
      return;
    }


    /* =====================================================
       #HELP
    ===================================================== */

    if (command === 'help') {

      const helpText = [

        '**🤖 Unity Bot — команды**',

        '',

        '`#help` — список команд',

        '`#tab` — TAB в виде изображения',

        '`#kp2` — перейти в KitPvP 2',

        '`#reconnect` — переподключить Minecraft',

        '',

        '**🟢 Friend**',

        '`#friendadd Ник` — добавить Friend',

        '`#friendremove Ник` — удалить Friend',

        '`#friends` — список Friend',

        '',

        '**🔴 enemy**',

        '`#enemyadd Ник` — добавить enemy',

        '`#enemyremove Ник` — удалить enemy',

        '`#enemies` — список enemy'

      ].join('\n');


      await message.reply(
        helpText
      );


      return;
    }


    /* =====================================================
       #TAB
    ===================================================== */

    if (command === 'tab') {

      try {

        /*
         * Если уже на КП2,
         * повторно подключаться не надо.
         */

        if (
          mcBot &&
          isOnKp2
        ) {

          console.log(
            '📋 #tab: бот уже на КП2.'
          );

        } else {

          /*
           * Если Minecraft отключён,
           * подключаемся.
           */

          if (!mcBot) {

            console.log(
              '📋 #tab: Minecraft отключён. Подключаю...'
            );


            shouldReconnect = true;


            connectMinecraft();


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

              await message.reply(
                '❌ Minecraft бот не смог подключиться.'
              );

              return;
            }


            /*
             * Ждём /login и /kp2.
             */

            await new Promise(
              resolve =>
                setTimeout(
                  resolve,
                  8000
                )
            );

          }


          if (
            mcBot &&
            !isOnKp2
          ) {

            console.log(
              '⚔️ #tab: отправляю /kp2.'
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


        /*
         * Создаём картинку.
         */

        console.log(
          '🖼️ Создаю изображение TAB...'
        );


        const imageBuffer =
          await createTabImage();


        /*
         * Отправляем PNG.
         */

        await message.reply({

          content:
            '📋 **MineBlaze TAB**',

          files: [
            {
              attachment:
                imageBuffer,

              name:
                'mineblaze-tab.png'
            }
          ]

        });


        console.log(
          '✅ TAB отправлен в Discord'
        );

      } catch (error) {

        console.log(
          '❌ Ошибка #tab:',
          error
        );


        await message.reply(
          '❌ Не удалось создать изображение TAB.'
        );

      }


      return;
    }


    /* =====================================================
       #KP2
    ===================================================== */

    if (command === 'kp2') {

      if (!mcBot) {

        await message.reply(
          '❌ Minecraft бот сейчас не подключён.'
        );

        return;
      }


      try {

        mcBot.chat(
          '/kp2'
        );

        isOnKp2 = true;


        await message.reply(
          '⚔️ Команда `/kp2` отправлена.'
        );

      } catch (error) {

        console.log(
          '❌ Ошибка #kp2:',
          error.message
        );

        await message.reply(
          '❌ Не удалось отправить `/kp2`.'
        );

      }


      return;
    }


    /* =====================================================
       #RECONNECT
    ===================================================== */

    if (command === 'reconnect') {

      await message.reply(
        '🔄 Переподключаю Minecraft...'
      );


      try {

        const connected =
          await reconnectMinecraft();


        if (connected) {

          await message.channel.send(
            '✅ Minecraft переподключён и отправлен на КП2.'
          );

        } else {

          await message.channel.send(
            '❌ Minecraft не удалось подключить.'
          );

        }

      } catch (error) {

        console.log(
          '❌ Ошибка #reconnect:',
          error.message
        );


        await message.channel.send(
          '❌ Ошибка при переподключении.'
        );

      }


      return;
    }


    /* =====================================================
       #FRIENDADD
    ===================================================== */

    if (command === 'friendadd') {

      const nick =
        args[0];


      if (!nick) {

        await message.reply(
          '❌ Использование: `#friendadd Ник`'
        );

        return;
      }


      try {

        await addTrackedPlayer(
          nick,
          'friend'
        );


        await message.reply(
          `🟢 **${nick}** добавлен в Friend.`
        );

      } catch (error) {

        console.log(
          '❌ Ошибка #friendadd:',
          error.message
        );


        await message.reply(
          '❌ Не удалось добавить игрока.'
        );

      }


      return;
    }


    /* =====================================================
       #FRIENDREMOVE
    ===================================================== */

    if (command === 'friendremove') {

      const nick =
        args[0];


      if (!nick) {

        await message.reply(
          '❌ Использование: `#friendremove Ник`'
        );

        return;
      }


      const removed =
        await removeTrackedPlayer(
          nick,
          'friend'
        );


      if (removed) {

        await message.reply(
          `🗑️ **${nick}** удалён из Friend.`
        );

      } else {

        await message.reply(
          `❌ **${nick}** не найден в Friend.`
        );

      }


      return;
    }


    /* =====================================================
       #FRIENDS
    ===================================================== */

    if (command === 'friends') {

      const friends =
        await getTrackedPlayers(
          'friend'
        );


      if (
        friends.length === 0
      ) {

        await message.reply(
          '🟢 Friend пуст.'
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


      const chunks =
        splitText(
          text
        );


      await message.reply(
        `**🟢 Friend (${friends.length})**\n${chunks[0]}`
      );


      for (
        let i = 1;
        i < chunks.length;
        i++
      ) {

        await message.channel.send(
          chunks[i]
        );

      }


      return;
    }


    /* =====================================================
       #ENEMYADD
    ===================================================== */

    if (command === 'enemyadd') {

      const nick =
        args[0];


      if (!nick) {

        await message.reply(
          '❌ Использование: `#enemyadd Ник`'
        );

        return;
      }


      try {

        await addTrackedPlayer(
          nick,
          'enemy'
        );


        await message.reply(
          `🔴 **${nick}** добавлен в enemy.`
        );

      } catch (error) {

        console.log(
          '❌ Ошибка #enemyadd:',
          error.message
        );


        await message.reply(
          '❌ Не удалось добавить игрока.'
        );

      }


      return;
    }


    /* =====================================================
       #ENEMYREMOVE
    ===================================================== */

    if (command === 'enemyremove') {

      const nick =
        args[0];


      if (!nick) {

        await message.reply(
          '❌ Использование: `#enemyremove Ник`'
        );

        return;
      }


      const removed =
        await removeTrackedPlayer(
          nick,
          'enemy'
        );


      if (removed) {

        await message.reply(
          `🗑️ **${nick}** удалён из enemy.`
        );

      } else {

        await message.reply(
          `❌ **${nick}** не найден в enemy.`
        );

      }


      return;
    }


    /* =====================================================
       #ENEMIES
    ===================================================== */

    if (command === 'enemies') {

      const enemies =
        await getTrackedPlayers(
          'enemy'
        );


      if (
        enemies.length === 0
      ) {

        await message.reply(
          '🔴 enemy пуст.'
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


      const chunks =
        splitText(
          text
        );


      await message.reply(
        `**🔴 enemy (${enemies.length})**\n${chunks[0]}`
      );


      for (
        let i = 1;
        i < chunks.length;
        i++
      ) {

        await message.channel.send(
          chunks[i]
        );

      }


      return;
    }

  }
);


/* =========================================================
   SPLIT TEXT
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
   DISCORD READY
========================================================= */

client.once(
  'clientReady',
  discordClient => {

    console.log(
      `🤖 Discord бот запущен: ${discordClient.user.tag}`
    );

    console.log(
      '💬 Prefix: #'
    );

    console.log(
      '📋 Команды: #help, #tab, #kp2, #reconnect'
    );

  }
);


/* =========================================================
   START
========================================================= */

async function start() {

  try {

    await initDatabase();


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
