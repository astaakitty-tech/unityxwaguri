const { Client, GatewayIntentBits } = require('discord.js');
const mineflayer = require('mineflayer');
const { Pool } = require('pg');
const sharp = require('sharp');
const http = require('http');

const {
  DISCORD_TOKEN,
  CHANNEL_ID,

  MINECRAFT_HOST,
  MINECRAFT_PORT,
  MINECRAFT_USERNAME,
  MINECRAFT_VERSION,
  SERVER_PASSWORD,

  DEXLAND_HOST,
  DEXLAND_PORT,
  DEXLAND_USERNAME,
  DEXLAND_VERSION,
  DEXLAND_PASSWORD,

  DATABASE_URL,
  PORT
} = process.env;

if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN не задан');
if (!CHANNEL_ID) throw new Error('CHANNEL_ID не задан');

if (!MINECRAFT_HOST || !MINECRAFT_USERNAME) {
  throw new Error('MineBlaze env не заполнен');
}

if (!DEXLAND_HOST || !DEXLAND_USERNAME) {
  throw new Error('DexLand env не заполнен');
}

if (!DATABASE_URL) throw new Error('DATABASE_URL не задан');

const MC_PORT = Number(MINECRAFT_PORT || 25565);
const DEX_PORT = Number(DEXLAND_PORT || 25565);

const MC_VERSION = MINECRAFT_VERSION?.trim() || false;
const DEX_VERSION = DEXLAND_VERSION?.trim() || false;

const RECONNECT_DELAY = 10000;
const AUTO_LEAVE_TIME = 10 * 60 * 1000;
const SKIN_CACHE_TIME = 30 * 60 * 1000;

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const bots = {
  mineblaze: {
    bot: null,
    connecting: false,
    reconnectTimer: null,
    autoLeaveTimer: null,
    shouldReconnect: true,
    captcha: false,
    other: false
  },

  dexland: {
    bot: null,
    connecting: false,
    reconnectTimer: null,
    autoLeaveTimer: null,
    shouldReconnect: true,
    captcha: false,
    other: false
  }
};

const skinCache = new Map();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const cleanText = value => {
  if (value == null) return '';

  if (typeof value !== 'string') {
    try {
      return cleanText(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }

  return value
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim();
};

const escapeXml = value =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const truncateText = (text, max) =>
  String(text).length <= max
    ? String(text)
    : String(text).slice(0, max - 1) + '…';

async function initDatabase() {
  const exists = (
    await pool.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'tracked_players'
      ) AS exists
    `)
  ).rows[0].exists;

  if (!exists) {
    await pool.query(`
      CREATE TABLE tracked_players (
        username TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('friend', 'enemy'))
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS tracked_players_username_lower_idx
      ON tracked_players (LOWER(username))
    `);

    console.log('[DB] Создана таблица tracked_players');
    return;
  }

  let cols = (
    await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = 'tracked_players'
    `)
  ).rows.map(row => row.column_name);

  if (!cols.includes('username')) {
    await pool.query(`
      ALTER TABLE tracked_players
      ADD COLUMN username TEXT
    `);

    cols = (
      await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'tracked_players'
      `)
    ).rows.map(row => row.column_name);

    const old = [
      'nickname',
      'nick',
      'player',
      'player_name',
      'name'
    ].find(x => cols.includes(x));

    if (old) {
      await pool.query(
        `UPDATE tracked_players
         SET username="${old.replace(/"/g, '""')}"
         WHERE username IS NULL`
      );
    }
  }

  cols = (
    await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = 'tracked_players'
    `)
  ).rows.map(row => row.column_name);

  if (!cols.includes('type')) {
    await pool.query(`
      ALTER TABLE tracked_players
      ADD COLUMN type TEXT
    `);

    const old = [
      'category',
      'role',
      'kind'
    ].find(x => cols.includes(x));

    if (old) {
      await pool.query(
        `UPDATE tracked_players
         SET type=LOWER("${old.replace(/"/g, '""')}")
         WHERE type IS NULL`
      );
    }

    await pool.query(`
      UPDATE tracked_players
      SET type='friend'
      WHERE type IS NULL
      OR LOWER(type) NOT IN ('friend', 'enemy')
    `);
  }

  await pool.query(`
    UPDATE tracked_players
    SET username=TRIM(username)
    WHERE username IS NOT NULL
  `);

  await pool.query(`
    DELETE FROM tracked_players
    WHERE username IS NULL
    OR TRIM(username)=''
  `);

  await pool.query(`
    UPDATE tracked_players
    SET type=LOWER(TRIM(type))
    WHERE type IS NOT NULL
  `);

  await pool.query(`
    DELETE FROM tracked_players
    WHERE type NOT IN ('friend', 'enemy')
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS tracked_players_username_lower_idx
    ON tracked_players (LOWER(username))
  `);

  console.log('[DB] Миграция tracked_players завершена');
}

async function addTrackedPlayer(username, type) {
  username = username.trim();

  if (!username) return;

  if (!['friend', 'enemy'].includes(type)) {
    throw new Error('Неверный тип игрока');
  }

  await pool.query(
    `DELETE FROM tracked_players
     WHERE LOWER(username)=LOWER($1)`,
    [username]
  );

  await pool.query(
    `INSERT INTO tracked_players(username,type)
     VALUES($1,$2)`,
    [username, type]
  );
}

async function removeTrackedPlayer(username) {
  await pool.query(
    `DELETE FROM tracked_players
     WHERE LOWER(username)=LOWER($1)`,
    [username.trim()]
  );
}

async function getTrackedPlayers(type) {
  return (
    await pool.query(
      `SELECT username
       FROM tracked_players
       WHERE type=$1
       ORDER BY LOWER(username)`,
      [type]
    )
  ).rows.map(row => row.username);
}

async function getTrackedMap() {
  const map = new Map();

  for (const row of (
    await pool.query(
      `SELECT username,type
       FROM tracked_players`
    )
  ).rows) {
    map.set(row.username.toLowerCase(), row.type);
  }

  return map;
}

async function getChannel() {
  try {
    const channel = await discord.channels.fetch(CHANNEL_ID);

    return channel?.isTextBased()
      ? channel
      : null;
  } catch (error) {
    console.log(
      `[Discord] Канал ${CHANNEL_ID}: ${error.message}`
    );

    return null;
  }
}

async function sendDiscordMessage(text) {
  const channel = await getChannel();

  if (!channel) return;

  try {
    await channel.send(text);
  } catch (error) {
    console.log(`[Discord] ${error.message}`);
  }
}

function isVerification(text) {
  const s = text.toLowerCase();

  return [
    'captcha',
    'verify',
    'verification',
    'robot',
    'anti bot',
    'antibot',
    'подтверд',
    'провер',
    'капча'
  ].some(x => s.includes(x));
}

function isOtherKick(text) {
  const s = text.toLowerCase();

  return [
    'с другого майнкрафта',
    'другого майнкрафта',
    'already logged in',
    'logged in from another',
    'another minecraft'
  ].some(x => s.includes(x));
}

function extractUrls(text) {
  return text.match(/https?:\/\/[^\s<>()]+/gi) || [];
}

async function getNameMcSkin(username) {
  const key = username.toLowerCase();

  const cached = skinCache.get(key);

  if (
    cached &&
    Date.now() - cached.time < SKIN_CACHE_TIME
  ) {
    return cached.buffer;
  }

  try {
    const response = await fetch(
      `https://ru.namemc.com/profile/${encodeURIComponent(username)}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
        }
      }
    );

    if (!response.ok) {
      throw new Error(
        `NameMC profile HTTP ${response.status}`
      );
    }

    const html = await response.text();

    const matches = [
      ...html.matchAll(
        /https?:\/\/s\.namemc\.com\/i\/([a-f0-9]+)\.png/gi
      )
    ];

    if (!matches.length) {
      throw new Error(
        'Скин не найден в профиле NameMC'
      );
    }

    const skinResponse = await fetch(
      `https://s.namemc.com/i/${matches[0][1]}.png`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      }
    );

    if (!skinResponse.ok) {
      throw new Error(
        `NameMC skin HTTP ${skinResponse.status}`
      );
    }

    const buffer = Buffer.from(
      await skinResponse.arrayBuffer()
    );

    skinCache.set(key, {
      time: Date.now(),
      buffer
    });

    return buffer;
  } catch (error) {
    console.log(
      `[NameMC] ${username}: ${error.message}`
    );

    return null;
  }
}

async function getPlayerHead(username) {
  const skin = await getNameMcSkin(username);

  if (!skin) return null;

  try {
    const face = await sharp(skin)
      .extract({
        left: 8,
        top: 8,
        width: 8,
        height: 8
      })
      .resize(40, 40, {
        kernel: 'nearest'
      })
      .png()
      .toBuffer();

    const hat = await sharp(skin)
      .extract({
        left: 40,
        top: 8,
        width: 8,
        height: 8
      })
      .resize(40, 40, {
        kernel: 'nearest'
      })
      .png()
      .toBuffer();

    return await sharp({
      create: {
        width: 40,
        height: 40,
        channels: 4,
        background: {
          r: 0,
          g: 0,
          b: 0,
          alpha: 0
        }
      }
    })
      .composite([
        {
          input: face,
          left: 0,
          top: 0
        },
        {
          input: hat,
          left: 0,
          top: 0
        }
      ])
      .png()
      .toBuffer();
  } catch (error) {
    console.log(
      `[NameMC] Голова ${username}: ${error.message}`
    );

    return null;
  }
}

function pingColor(ping) {
  const n = Number(ping);

  if (!Number.isFinite(n)) {
    return '#aaaaaa';
  }

  if (n <= 80) return '#55ff55';
  if (n <= 150) return '#ffff55';
  if (n <= 250) return '#ffaa00';

  return '#ff5555';
}

function row(svg, player, x, y, width) {
  const ping = Number.isFinite(Number(player.ping))
    ? `${Math.round(Number(player.ping))}ms`
    : '?';

  svg.push(`
    <rect
      x="${x}"
      y="${y}"
      width="${width}"
      height="40"
      rx="8"
      fill="#101d17"
      stroke="#1d3a2a"
    />
  `);

  if (player.head) {
    svg.push(`
      <image
        href="data:image/png;base64,${player.head.toString('base64')}"
        x="${x + 6}"
        y="${y + 2}"
        width="34"
        height="34"
        preserveAspectRatio="none"
      />
    `);
  } else {
    svg.push(`
      <rect
        x="${x + 6}"
        y="${y + 2}"
        width="34"
        height="34"
        rx="5"
        fill="#26372e"
      />

      <text
        x="${x + 23}"
        y="${y + 26}"
        text-anchor="middle"
        font-size="16"
        fill="#8fa99a"
        font-family="Arial"
      >?</text>
    `);
  }

  svg.push(`
    <text
      x="${x + 48}"
      y="${y + 25}"
      font-size="16"
      font-weight="600"
      fill="#fff"
      font-family="Arial"
    >
      ${escapeXml(
        truncateText(player.username, 18)
      )}
    </text>

    <text
      x="${x + width - 10}"
      y="${y + 25}"
      text-anchor="end"
      font-size="13"
      font-weight="600"
      fill="${pingColor(player.ping)}"
      font-family="Arial"
    >
      ${ping}
    </text>
  `);
}

function panel(svg, x, y, width, height, title, color) {
  svg.push(`
    <rect
      x="${x}"
      y="${y}"
      width="${width}"
      height="${height}"
      rx="16"
      fill="#0b1510"
      stroke="#234432"
      stroke-width="2"
    />

    <rect
      x="${x}"
      y="${y}"
      width="${width}"
      height="54"
      rx="16"
      fill="#0e1c14"
    />

    <rect
      x="${x}"
      y="${y + 42}"
      width="${width}"
      height="12"
      fill="#0e1c14"
    />

    <text
      x="${x + width / 2}"
      y="${y + 35}"
      text-anchor="middle"
      font-size="22"
      font-weight="700"
      fill="${color}"
      font-family="Arial"
    >
      ${title}
    </text>
  `);
}

async function createTabImage(key) {
  const bot = bots[key].bot;

  if (!bot) {
    throw new Error(
      `${key === 'mineblaze'
        ? 'MineBlaze'
        : 'DexLand'} бот не подключён`
    );
  }

  const tracked = await getTrackedMap();

  const players = Object.values(bot.players || {})
    .filter(player =>
      player?.username &&
      !/staff\s+in\s+vanish/i.test(
        cleanText(player.username)
      )
    )
    .map(player => ({
      username: player.username,
      ping: player.ping,
      type:
        tracked.get(
          player.username.toLowerCase()
        ) || null,
      head: null
    }));

  const queue = [...players];

  async function worker() {
    while (queue.length) {
      const player = queue.shift();

      if (player) {
        player.head = await getPlayerHead(
          player.username
        );
      }
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.min(5, players.length)
      },
      worker
    )
  );

  const sortPlayers = array =>
    array.sort((a, b) =>
      a.username.localeCompare(
        b.username,
        undefined,
        {
          sensitivity: 'base'
        }
      )
    );

  const friends = sortPlayers(
    players.filter(player =>
      player.type === 'friend'
    )
  );

  const enemies = sortPlayers(
    players.filter(player =>
      player.type === 'enemy'
    )
  );

  const normal = sortPlayers(
    players.filter(player =>
      !player.type
    )
  );

  const W = 1800;
  const SW = 360;
  const G = 22;

  const L = 40;
  const C = L + SW + G;

  const CW =
    W -
    SW * 2 -
    G * 2 -
    80;

  const R =
    C +
    CW +
    G;

  const Y = 150;
  const TOP = 75;
  const RH = 44;

  const rows = Math.max(
    Math.ceil(normal.length / 2),
    friends.length,
    enemies.length,
    1
  );

  const PH = Math.max(
    180,
    TOP + rows * RH + 30
  );

  const H = Y + PH + 45;

  const name =
    key === 'mineblaze'
      ? 'MineBlaze'
      : 'DexLand';

  const host =
    key === 'mineblaze'
      ? MINECRAFT_HOST
      : DEXLAND_HOST;

  const svg = [
    `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="${W}"
      height="${H}"
      viewBox="0 0 ${W} ${H}"
    >

    <rect
      width="${W}"
      height="${H}"
      fill="#06100a"
    />

    <text
      x="${W / 2}"
      y="48"
      text-anchor="middle"
      font-size="26"
      font-weight="700"
      fill="#55ff55"
      font-family="Arial"
    >
      Online
    </text>

    <text
      x="${W / 2}"
      y="92"
      text-anchor="middle"
      font-size="38"
      font-weight="700"
      fill="#fff"
      font-family="Arial"
    >
      ${name} — TAB
    </text>

    <text
      x="${W / 2}"
      y="126"
      text-anchor="middle"
      font-size="19"
      fill="#9db5a4"
      font-family="Arial"
    >
      Server: ${escapeXml(host)} • Players: ${players.length}
    </text>
    `
  ];

  panel(
    svg,
    L,
    Y,
    SW,
    PH,
    'Friend',
    '#55ff55'
  );

  panel(
    svg,
    C,
    Y,
    CW,
    PH,
    'Players',
    '#fff'
  );

  panel(
    svg,
    R,
    Y,
    SW,
    PH,
    'enemy',
    '#ff5555'
  );

  friends.forEach((player, index) => {
    row(
      svg,
      player,
      L + 12,
      Y + TOP + index * RH,
      SW - 24
    );
  });

  enemies.forEach((player, index) => {
    row(
      svg,
      player,
      R + 12,
      Y + TOP + index * RH,
      SW - 24
    );
  });

  const colW = Math.floor(
    (CW - 36) / 2
  );

  normal.forEach((player, index) => {
    const col = index % 2;
    const rowIndex = Math.floor(index / 2);

    row(
      svg,
      player,
      C +
        12 +
        col * (colW + 12),
      Y +
        TOP +
        rowIndex * RH,
      colW
    );
  });

  svg.push(`
    <text
      x="${W / 2}"
      y="${H - 16}"
      text-anchor="middle"
      font-size="14"
      fill="#5e7565"
      font-family="Arial"
    >
      ${name} • Discord Bot
    </text>

    </svg>
  `);

  return sharp(
    Buffer.from(svg.join(''))
  )
    .png()
    .toBuffer();
}

function clearLeave(key) {
  if (bots[key].autoLeaveTimer) {
    clearTimeout(
      bots[key].autoLeaveTimer
    );

    bots[key].autoLeaveTimer = null;
  }
}

function scheduleLeave(key) {
  clearLeave(key);

  bots[key].autoLeaveTimer =
    setTimeout(() => {
      try {
        bots[key].bot?.quit(
          '10 minute auto leave'
        );
      } catch {}
    }, AUTO_LEAVE_TIME);
}

function scheduleReconnect(key) {
  const state = bots[key];

  if (
    state.reconnectTimer ||
    !state.shouldReconnect ||
    state.captcha ||
    state.other
  ) {
    return;
  }

  state.reconnectTimer =
    setTimeout(() => {
      state.reconnectTimer = null;

      if (
        state.shouldReconnect &&
        !state.captcha &&
        !state.other
      ) {
        connectServer(key);
      }
    }, RECONNECT_DELAY);
}

async function connectServer(key) {
  const state = bots[key];

  if (
    state.connecting ||
    state.bot?.player
  ) {
    return;
  }

  state.connecting = true;
  state.other = false;

  const mineblaze =
    key === 'mineblaze';

  const host = mineblaze
    ? MINECRAFT_HOST
    : DEXLAND_HOST;

  const port = mineblaze
    ? MC_PORT
    : DEX_PORT;

  const username = mineblaze
    ? MINECRAFT_USERNAME
    : DEXLAND_USERNAME;

  const version = mineblaze
    ? MC_VERSION
    : DEX_VERSION;

  const password = mineblaze
    ? SERVER_PASSWORD
    : DEXLAND_PASSWORD;

  const name = mineblaze
    ? 'MineBlaze'
    : 'DexLand';

  console.log(
    `[${name}] Подключение к ${host}:${port}...`
  );

  try {
    const options = {
      host,
      port,
      username,
      auth: 'offline'
    };

    if (version) {
      options.version = version;
    }

    const bot =
      mineflayer.createBot(options);

    state.bot = bot;

    bot.once(
      'login',
      async () => {
        console.log(
          `[${name}] Вошёл как ${username}`
        );

        await sleep(3000);

        if (password?.trim()) {
          try {
            bot.chat(
              `/login ${password.trim()}`
            );

            console.log(
              `[${name}] Отправлен /login`
            );
          } catch (error) {
            console.log(
              `[${name}] /login: ${error.message}`
            );
          }
        }

        if (
          mineblaze &&
          state.shouldReconnect &&
          !state.captcha &&
          !state.other
        ) {
          await sleep(4000);

          try {
            bot.chat('/kp2');

            console.log(
              '[MineBlaze] Отправлен /kp2'
            );
          } catch (error) {
            console.log(
              `[MineBlaze] /kp2: ${error.message}`
            );
          }
        }
      }
    );

    bot.once(
      'spawn',
      () => {
        console.log(
          `[${name}] Spawn`
        );

        scheduleLeave(key);
      }
    );

    const handleMessage =
      async raw => {
        const text =
          cleanText(raw);

        if (!text) return;

        console.log(
          `[${name}] ${text}`
        );

        if (isOtherKick(text)) {
          state.other = true;
          state.shouldReconnect = false;

          await sendDiscordMessage(
            `⚠️ **${name}: аккаунт уже используется другим клиентом.**\n\n` +
            `Автоматический reconnect остановлен.`
          );

          return;
        }

        if (isVerification(text)) {
          state.captcha = true;
          state.shouldReconnect = false;

          const urls =
            extractUrls(text);

          await sendDiscordMessage(
            `⚠️ **Обнаружена проверка/капча на ${name}.**\n\n` +
            `Автоматический reconnect остановлен.` +
            (
              urls.length
                ? `\n\n🔗 ${urls.join('\n')}`
                : ''
            )
          );
        }
      };

    bot.on(
      'messagestr',
      handleMessage
    );

    bot.on(
      'message',
      message =>
        handleMessage(
          message.toString()
        )
    );

    bot.on(
      'kicked',
      async reason => {
        const text =
          cleanText(reason);

        console.log(
          `[${name}] Kicked: ${text}`
        );

        if (isOtherKick(text)) {
          state.other = true;
          state.shouldReconnect = false;

          await sendDiscordMessage(
            `⚠️ **${name}: аккаунт уже используется другим клиентом.**\n\n` +
            `Автоматический reconnect остановлен.`
          );

          return;
        }

        await sendDiscordMessage(
          `⚠️ **${name}** бот был кикнут.\n` +
          `\`${truncateText(text, 1200)}\``
        );
      }
    );

    bot.on(
      'error',
      error => {
        console.log(
          `[${name}] Error: ${error.message}`
        );
      }
    );

    bot.on(
      'end',
      reason => {
        console.log(
          `[${name}] Соединение закрыто: ${
            reason || 'unknown'
          }`
        );

        if (state.bot === bot) {
          state.bot = null;
        }

        state.connecting = false;

        clearLeave(key);

        if (
          state.shouldReconnect &&
          !state.captcha &&
          !state.other
        ) {
          scheduleReconnect(key);
        }
      }
    );
  } catch (error) {
    console.log(
      `[${name}] Ошибка подключения: ${error.message}`
    );

    state.bot = null;

    if (
      state.shouldReconnect &&
      !state.captcha &&
      !state.other
    ) {
      scheduleReconnect(key);
    }
  } finally {
    state.connecting = false;
  }
}

async function reconnectServer(key) {
  const state = bots[key];

  state.captcha = false;
  state.other = false;
  state.shouldReconnect = true;

  if (state.reconnectTimer) {
    clearTimeout(
      state.reconnectTimer
    );

    state.reconnectTimer = null;
  }

  if (state.bot) {
    try {
      state.bot.quit(
        'Manual reconnect'
      );
    } catch {}

    state.bot = null;
  }

  await sleep(1500);

  await connectServer(key);
}

function help() {
  return [
    '🤖 **Minecraft Discord Bot**',
    '',
    '`#help` — список команд',
    '`#tab` — два TAB: MineBlaze + DexLand',
    '`#kp2` — KitPvP 2 на MineBlaze',
    '`#reconnect` — переподключить оба сервера',
    '',
    '`#friendadd Nick` — добавить друга',
    '`#friendremove Nick` — удалить друга',
    '`#friends` — список друзей',
    '',
    '`#enemyadd Nick` — добавить врага',
    '`#enemyremove Nick` — удалить врага',
    '`#enemies` — список врагов'
  ].join('\n');
}

async function sendBothTabs(message) {
  await message.reply(
    '⏳ Получаю TAB с **MineBlaze** и **DexLand**...'
  );

  const servers = [
    [
      'mineblaze',
      'MineBlaze',
      'mineblaze-tab.png'
    ],
    [
      'dexland',
      'DexLand',
      'dexland-tab.png'
    ]
  ];

  for (const [
    key,
    name,
    filename
  ] of servers) {
    if (!bots[key].bot) {
      await connectServer(key);
      await sleep(7000);
    }

    if (!bots[key].bot) {
      await message.channel.send(
        `❌ ${name}: не удалось подключиться.`
      );

      continue;
    }

    try {
      const image =
        await createTabImage(key);

      await message.channel.send({
        content:
          `📋 **${name} — TAB**`,

        files: [
          {
            attachment: image,
            name: filename
          }
        ]
      });
    } catch (error) {
      console.log(
        `[TAB] ${name}: ${
          error.stack || error.message
        }`
      );

      await message.channel.send(
        `❌ ${name}: ${error.message}`
      );
    }
  }
}

discord.on(
  'messageCreate',
  async message => {
    try {
      if (message.author.bot) return;

      if (
        message.channel.id !== CHANNEL_ID
      ) {
        return;
      }

      const content =
        message.content.trim();

      if (!content.startsWith('#')) {
        return;
      }

      const args =
        content.split(/\s+/);

      const cmd =
        args[0]
          .slice(1)
          .toLowerCase();

      const value =
        args
          .slice(1)
          .join(' ')
          .trim();

      if (cmd === 'help') {
        await message.reply(help());
        return;
      }

      if (cmd === 'tab') {
        await sendBothTabs(message);
        return;
      }

      if (cmd === 'kp2') {
        const state =
          bots.mineblaze;

        if (!state.bot) {
          await connectServer(
            'mineblaze'
          );

          await sleep(7000);
        }

        if (state.bot) {
          state.bot.chat('/kp2');

          await message.reply(
            '🎮 MineBlaze: отправил `/kp2`.'
          );
        } else {
          await message.reply(
            '❌ MineBlaze не подключён.'
          );
        }

        return;
      }

      if (cmd === 'reconnect') {
        await message.reply(
          '🔄 Переподключаю MineBlaze и DexLand...'
        );

        await Promise.all([
          reconnectServer('mineblaze'),
          reconnectServer('dexland')
        ]);

        await message.reply(
          '✅ Reconnect запущен для обоих серверов.'
        );

        return;
      }

      if (cmd === 'friendadd') {
        if (!value) {
          return message.reply(
            'Использование: `#friendadd Nick`'
          );
        }

        await addTrackedPlayer(
          value,
          'friend'
        );

        await message.reply(
          `🟢 **${value}** добавлен в Friend.`
        );

        return;
      }

      if (cmd === 'friendremove') {
        if (!value) {
          return message.reply(
            'Использование: `#friendremove Nick`'
          );
        }

        await removeTrackedPlayer(
          value
        );

        await message.reply(
          `🗑️ **${value}** удалён из списка.`
        );

        return;
      }

      if (cmd === 'friends') {
        const players =
          await getTrackedPlayers(
            'friend'
          );

        await message.reply(
          players.length
            ? `🟢 **Friends (${players.length})**\n\n` +
              players
                .map(x => `• ${x}`)
                .join('\n')
            : '🟢 Friend список пуст.'
        );

        return;
      }

      if (cmd === 'enemyadd') {
        if (!value) {
          return message.reply(
            'Использование: `#enemyadd Nick`'
          );
        }

        await addTrackedPlayer(
          value,
          'enemy'
        );

        await message.reply(
          `🔴 **${value}** добавлен в enemy.`
        );

        return;
      }

      if (cmd === 'enemyremove') {
        if (!value) {
          return message.reply(
            'Использование: `#enemyremove Nick`'
          );
        }

        await removeTrackedPlayer(
          value
        );

        await message.reply(
          `🗑️ **${value}** удалён из списка.`
        );

        return;
      }

      if (cmd === 'enemies') {
        const players =
          await getTrackedPlayers(
            'enemy'
          );

        await message.reply(
          players.length
            ? `🔴 **Enemies (${players.length})**\n\n` +
              players
                .map(x => `• ${x}`)
                .join('\n')
            : '🔴 Enemy список пуст.'
        );

        return;
      }
    } catch (error) {
      console.log(
        `[Discord] Ошибка команды: ${
          error.stack || error.message
        }`
      );

      try {
        await message.reply(
          `❌ Произошла ошибка: \`${error.message}\``
        );
      } catch {}
    }
  }
);

discord.once(
  'clientReady',
  async () => {
    console.log(
      `[Discord] Бот запущен как ${discord.user.tag}`
    );

    console.log(
      `[Discord] Канал: ${CHANNEL_ID}`
    );

    await connectServer(
      'mineblaze'
    );

    await connectServer(
      'dexland'
    );
  }
);

const server =
  http.createServer(
    (req, res) => {
      res.writeHead(
        200,
        {
          'Content-Type':
            'text/plain; charset=utf-8'
        }
      );

      res.end(
        'MineBlaze + DexLand Discord Bot is running.'
      );
    }
  );

server.listen(
  Number(PORT || 3000),
  '0.0.0.0',
  () => {
    console.log(
      `[HTTP] Server listening on port ${
        PORT || 3000
      }`
    );
  }
);

async function shutdown() {
  console.log(
    '[System] Выключение...'
  );

  for (
    const key of [
      'mineblaze',
      'dexland'
    ]
  ) {
    const state = bots[key];

    state.shouldReconnect = false;

    if (state.reconnectTimer) {
      clearTimeout(
        state.reconnectTimer
      );
    }

    clearLeave(key);

    try {
      state.bot?.quit(
        'Bot shutdown'
      );
    } catch {}

    state.bot = null;
  }

  try {
    await pool.end();
  } catch {}

  try {
    discord.destroy();
  } catch {}

  server.close(
    () => process.exit(0)
  );

  setTimeout(
    () => process.exit(0),
    3000
  );
}

process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
);

(async () => {
  console.log(
    '======================================'
  );

  console.log(
    ' MineBlaze + DexLand Discord Bot'
  );

  console.log(
    '======================================'
  );

  await initDatabase();

  await discord.login(
    DISCORD_TOKEN
  );
})().catch(error => {
  console.error(
    '[System] Критическая ошибка:',
    error
  );

  process.exit(1);
});
