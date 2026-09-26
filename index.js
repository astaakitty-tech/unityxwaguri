const {
  Client,
  GatewayIntentBits
} = require("discord.js");

const mineflayer = require("mineflayer");
const { Pool } = require("pg");
const sharp = require("sharp");
const http = require("http");

// ============================================================
// ENV
// ============================================================

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

// ============================================================
// CHECK ENV
// ============================================================

if (!DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN не задан");
}

if (!CHANNEL_ID) {
  throw new Error("CHANNEL_ID не задан");
}

if (!MINECRAFT_HOST) {
  throw new Error("MINECRAFT_HOST не задан");
}

if (!MINECRAFT_USERNAME) {
  throw new Error("MINECRAFT_USERNAME не задан");
}

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL не задан");
}

// ============================================================
// SETTINGS
// ============================================================

const PREFIX = "#";

const MC_PORT = Number(
  MINECRAFT_PORT || 25565
);

const MC_VERSION =
  MINECRAFT_VERSION &&
  MINECRAFT_VERSION.trim()
    ? MINECRAFT_VERSION.trim()
    : false;

const RECONNECT_DELAY = 10_000;

const AUTO_LEAVE_TIME =
  10 * 60 * 1000;

const SKIN_CACHE_TIME =
  30 * 60 * 1000;

// ============================================================
// DISCORD
// ============================================================

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ============================================================
// DATABASE
// ============================================================

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ============================================================
// DATABASE HELPERS
// ============================================================

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function getTableColumns(tableName) {
  const result = await pool.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
    `,
    [tableName]
  );

  return result.rows.map(
    row => row.column_name
  );
}

// ============================================================
// DATABASE INIT / MIGRATION
// ============================================================

async function initDatabase() {
  const tableResult = await pool.query(
    `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'tracked_players'
    ) AS exists
    `
  );

  const exists =
    tableResult.rows[0].exists;

  // ----------------------------------------------------------
  // NEW TABLE
  // ----------------------------------------------------------

  if (!exists) {
    await pool.query(`
      CREATE TABLE tracked_players (
        username TEXT NOT NULL,
        type TEXT NOT NULL
          CHECK (type IN ('friend', 'enemy'))
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
      tracked_players_username_lower_idx
      ON tracked_players (LOWER(username))
    `);

    console.log(
      "[DB] Создана таблица tracked_players"
    );

    return;
  }

  // ----------------------------------------------------------
  // OLD TABLE EXISTS
  // ----------------------------------------------------------

  let columns =
    await getTableColumns(
      "tracked_players"
    );

  console.log(
    `[DB] Существующие колонки: ${columns.join(", ")}`
  );

  // ----------------------------------------------------------
  // USERNAME
  // ----------------------------------------------------------

  if (!columns.includes("username")) {
    console.log(
      "[DB] Колонка username отсутствует. Добавляю..."
    );

    await pool.query(`
      ALTER TABLE tracked_players
      ADD COLUMN username TEXT
    `);

    columns =
      await getTableColumns(
        "tracked_players"
      );

    // Попробуем перенести данные из старой колонки.
    const possibleNameColumns = [
      "nickname",
      "nick",
      "player",
      "player_name",
      "name"
    ];

    const oldNameColumn =
      possibleNameColumns.find(
        column =>
          columns.includes(column)
      );

    if (oldNameColumn) {
      console.log(
        `[DB] Переношу имена из колонки ${oldNameColumn}`
      );

      await pool.query(`
        UPDATE tracked_players
        SET username = ${quoteIdentifier(oldNameColumn)}
        WHERE username IS NULL
      `);
    }
  }

  // ----------------------------------------------------------
  // TYPE
  // ----------------------------------------------------------

  columns =
    await getTableColumns(
      "tracked_players"
    );

  if (!columns.includes("type")) {
    console.log(
      "[DB] Колонка type отсутствует. Добавляю..."
    );

    await pool.query(`
      ALTER TABLE tracked_players
      ADD COLUMN type TEXT
    `);

    /*
      Если в старой таблице была колонка category,
      role или kind — попробуем её использовать.
    */

    const possibleTypeColumns = [
      "category",
      "role",
      "kind"
    ];

    const oldTypeColumn =
      possibleTypeColumns.find(
        column =>
          columns.includes(column)
      );

    if (oldTypeColumn) {
      await pool.query(`
        UPDATE tracked_players
        SET type = LOWER(${quoteIdentifier(oldTypeColumn)})
        WHERE type IS NULL
      `);
    }

    /*
      Непонятные старые записи не должны ломать базу.
      По умолчанию ставим friend.
    */

    await pool.query(`
      UPDATE tracked_players
      SET type = 'friend'
      WHERE type IS NULL
         OR LOWER(type) NOT IN ('friend', 'enemy')
    `);
  }

  // ----------------------------------------------------------
  // CLEAN USERNAME
  // ----------------------------------------------------------

  await pool.query(`
    UPDATE tracked_players
    SET username = TRIM(username)
    WHERE username IS NOT NULL
  `);

  // Удаляем пустые строки
  await pool.query(`
    DELETE FROM tracked_players
    WHERE username IS NULL
       OR TRIM(username) = ''
  `);

  // ----------------------------------------------------------
  // NORMALIZE TYPE
  // ----------------------------------------------------------

  await pool.query(`
    UPDATE tracked_players
    SET type = LOWER(TRIM(type))
    WHERE type IS NOT NULL
  `);

  await pool.query(`
    DELETE FROM tracked_players
    WHERE type NOT IN ('friend', 'enemy')
  `);

  // ----------------------------------------------------------
  // INDEX
  // ----------------------------------------------------------

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    tracked_players_username_lower_idx
    ON tracked_players (LOWER(username))
  `);

  console.log(
    "[DB] Миграция tracked_players завершена"
  );
}

// ============================================================
// ADD PLAYER
// ============================================================

async function addTrackedPlayer(
  username,
  type
) {
  username = username.trim();

  if (!username) {
    return;
  }

  if (
    type !== "friend" &&
    type !== "enemy"
  ) {
    throw new Error(
      "Неверный тип игрока"
    );
  }

  /*
    Не используем ON CONFLICT,
    поэтому старый PRIMARY KEY больше
    не мешает работе.

    Сначала удаляем старую запись,
    затем добавляем новую.
  */

  await pool.query(
    `
    DELETE FROM tracked_players
    WHERE LOWER(username) = LOWER($1)
    `,
    [username]
  );

  await pool.query(
    `
    INSERT INTO tracked_players
      (username, type)
    VALUES
      ($1, $2)
    `,
    [username, type]
  );
}

// ============================================================
// REMOVE PLAYER
// ============================================================

async function removeTrackedPlayer(
  username
) {
  username = username.trim();

  if (!username) {
    return;
  }

  await pool.query(
    `
    DELETE FROM tracked_players
    WHERE LOWER(username) = LOWER($1)
    `,
    [username]
  );
}

// ============================================================
// GET PLAYERS
// ============================================================

async function getTrackedPlayers(
  type
) {
  const result =
    await pool.query(
      `
      SELECT username
      FROM tracked_players
      WHERE type = $1
      ORDER BY LOWER(username)
      `,
      [type]
    );

  return result.rows.map(
    row => row.username
  );
}

// ============================================================
// GET MAP
// ============================================================

async function getTrackedMap() {
  const result =
    await pool.query(`
      SELECT username, type
      FROM tracked_players
    `);

  const map = new Map();

  for (const row of result.rows) {
    map.set(
      row.username.toLowerCase(),
      row.type
    );
  }

  return map;
}

// ============================================================
// DISCORD CHANNELS
// ============================================================

function getChannelIds() {
  return [
    CHANNEL_ID,
    CHANNEL_ID_2
  ].filter(Boolean);
}

async function getDiscordChannels() {
  const channels = [];

  for (const id of getChannelIds()) {
    try {
      const channel =
        await discord.channels.fetch(id);

      if (
        channel &&
        channel.isTextBased()
      ) {
        channels.push(channel);
      }
    } catch (error) {
      console.log(
        `[Discord] Не удалось получить канал ${id}: ${error.message}`
      );
    }
  }

  return channels;
}

// ============================================================
// SEND DISCORD MESSAGE
// ============================================================

async function sendDiscordMessage(
  text
) {
  const channels =
    await getDiscordChannels();

  for (const channel of channels) {
    try {
      await channel.send(text);
    } catch (error) {
      console.log(
        `[Discord] Ошибка отправки в ${channel.id}: ${error.message}`
      );
    }
  }
}

// ============================================================
// UTILS
// ============================================================

function cleanText(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  if (typeof value === "string") {
    return value
      .replace(
        /§[0-9a-fk-or]/gi,
        ""
      )
      .replace(
        /\u001b\[[0-9;]*m/g,
        ""
      )
      .trim();
  }

  try {
    return cleanText(
      JSON.stringify(value)
    );
  } catch {
    return String(value);
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncateText(
  text,
  maxLength
) {
  text = String(text);

  if (
    text.length <= maxLength
  ) {
    return text;
  }

  return (
    text.slice(
      0,
      maxLength - 1
    ) + "…"
  );
}

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

// ============================================================
// MINECRAFT STATE
// ============================================================

let mcBot = null;

let isConnecting = false;

let reconnectTimer = null;

let autoLeaveTimer = null;

let shouldReconnect = true;

let captchaDetected = false;

let anotherClientDetected = false;

// ============================================================
// NAME MC CACHE
// ============================================================

const skinCache = new Map();

// ============================================================
// GET SKIN FROM NAMEMC
// ============================================================

async function getNameMcSkin(
  username
) {
  const key =
    username.toLowerCase();

  const cached =
    skinCache.get(key);

  if (
    cached &&
    Date.now() - cached.time <
      SKIN_CACHE_TIME
  ) {
    return cached.buffer;
  }

  try {
    const profileUrl =
      `https://ru.namemc.com/profile/${encodeURIComponent(username)}`;

    const response =
      await fetch(
        profileUrl,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
            "Accept-Language":
              "ru-RU,ru;q=0.9,en;q=0.8"
          }
        }
      );

    if (!response.ok) {
      throw new Error(
        `NameMC profile HTTP ${response.status}`
      );
    }

    const html =
      await response.text();

    const matches = [
      ...html.matchAll(
        /https?:\/\/s\.namemc\.com\/i\/([a-f0-9]+)\.png/gi
      )
    ];

    if (!matches.length) {
      throw new Error(
        "Скин не найден в профиле NameMC"
      );
    }

    const skinHash =
      matches[0][1];

    const skinUrl =
      `https://s.namemc.com/i/${skinHash}.png`;

    const skinResponse =
      await fetch(
        skinUrl,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0"
          }
        }
      );

    if (!skinResponse.ok) {
      throw new Error(
        `NameMC skin HTTP ${skinResponse.status}`
      );
    }

    const buffer =
      Buffer.from(
        await skinResponse.arrayBuffer()
      );

    skinCache.set(
      key,
      {
        time: Date.now(),
        buffer
      }
    );

    return buffer;
  } catch (error) {
    console.log(
      `[NameMC] ${username}: ${error.message}`
    );

    return null;
  }
}

// ============================================================
// CREATE PLAYER HEAD
// ============================================================

async function getPlayerHead(
  username
) {
  const skin =
    await getNameMcSkin(
      username
    );

  if (!skin) {
    return null;
  }

  try {
    const face =
      await sharp(skin)
        .extract({
          left: 8,
          top: 8,
          width: 8,
          height: 8
        })
        .resize(
          40,
          40,
          {
            kernel: "nearest"
          }
        )
        .png()
        .toBuffer();

    const hat =
      await sharp(skin)
        .extract({
          left: 40,
          top: 8,
          width: 8,
          height: 8
        })
        .resize(
          40,
          40,
          {
            kernel: "nearest"
          }
        )
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
      `[NameMC] Ошибка головы ${username}: ${error.message}`
    );

    return null;
  }
}

// ============================================================
// PING COLOR
// ============================================================

function getPingColor(ping) {
  const value =
    Number(ping);

  if (
    !Number.isFinite(value)
  ) {
    return "#aaaaaa";
  }

  if (value <= 80) {
    return "#55ff55";
  }

  if (value <= 150) {
    return "#ffff55";
  }

  if (value <= 250) {
    return "#ffaa00";
  }

  return "#ff5555";
}

// ============================================================
// TAB PLAYER ROW
// ============================================================

function createPlayerRow(
  svg,
  player,
  x,
  y,
  width,
  compact = false
) {
  const rowHeight =
    compact ? 44 : 52;

  const headSize =
    compact ? 34 : 40;

  const username =
    truncateText(
      player.username,
      compact ? 18 : 22
    );

  const ping =
    Number.isFinite(
      Number(player.ping)
    )
      ? `${Math.round(
          Number(player.ping)
        )}ms`
      : "?";

  const pingColor =
    getPingColor(
      player.ping
    );

  svg.push(`
    <rect
      x="${x}"
      y="${y}"
      width="${width}"
      height="${rowHeight - 4}"
      rx="8"
      fill="#101d17"
      stroke="#1d3a2a"
      stroke-width="1"
    />
  `);

  if (player.head) {
    const dataUri =
      `data:image/png;base64,${player.head.toString("base64")}`;

    svg.push(`
      <image
        href="${dataUri}"
        x="${x + 6}"
        y="${y + 2}"
        width="${headSize}"
        height="${headSize}"
        preserveAspectRatio="none"
      />
    `);
  } else {
    svg.push(`
      <rect
        x="${x + 6}"
        y="${y + 2}"
        width="${headSize}"
        height="${headSize}"
        rx="5"
        fill="#26372e"
      />

      <text
        x="${x + 6 + headSize / 2}"
        y="${y + 26}"
        text-anchor="middle"
        font-size="16"
        fill="#8fa99a"
        font-family="Arial, sans-serif"
      >?</text>
    `);
  }

  svg.push(`
    <text
      x="${x + headSize + 14}"
      y="${y + 22}"
      font-size="${compact ? 16 : 19}"
      font-weight="600"
      fill="#ffffff"
      font-family="Arial, sans-serif"
    >${escapeXml(username)}</text>

    <text
      x="${x + width - 10}"
      y="${y + 22}"
      text-anchor="end"
      font-size="${compact ? 13 : 16}"
      font-weight="600"
      fill="${pingColor}"
      font-family="Arial, sans-serif"
    >${escapeXml(ping)}</text>
  `);
}

// ============================================================
// PANEL
// ============================================================

function createPanelBackground(
  svg,
  x,
  y,
  width,
  height,
  title,
  titleColor
) {
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
      fill="${titleColor}"
      font-family="Arial, sans-serif"
    >${escapeXml(title)}</text>
  `);
}

// ============================================================
// CREATE TAB IMAGE
// ============================================================

async function createTabImage() {
  if (!mcBot) {
    throw new Error(
      "Minecraft бот не подключён"
    );
  }

  const tracked =
    await getTrackedMap();

  const allPlayers =
    Object.values(
      mcBot.players || {}
    );

  const players =
    allPlayers
      .filter(
        player =>
          player &&
          player.username
      )
      .filter(
        player =>
          !/staff\s+in\s+vanish/i.test(
            cleanText(
              player.username
            )
          )
      )
      .map(player => ({
        username:
          player.username,
        ping:
          player.ping,
        type:
          tracked.get(
            player.username.toLowerCase()
          ) || null,
        head: null
      }));

  // ----------------------------------------------------------
  // SKINS
  // ----------------------------------------------------------

  const queue = [
    ...players
  ];

  async function worker() {
    while (queue.length) {
      const player =
        queue.shift();

      if (!player) {
        break;
      }

      player.head =
        await getPlayerHead(
          player.username
        );
    }
  }

  const workerCount =
    Math.min(
      5,
      players.length
    );

  await Promise.all(
    Array.from(
      {
        length: workerCount
      },
      () => worker()
    )
  );

  // ----------------------------------------------------------
  // GROUPS
  // ----------------------------------------------------------

  const sortPlayers =
    array =>
      array.sort(
        (a, b) =>
          a.username.localeCompare(
            b.username,
            undefined,
            {
              sensitivity:
                "base"
            }
          )
      );

  const friends =
    sortPlayers(
      players.filter(
        player =>
          player.type ===
          "friend"
      )
    );

  const enemies =
    sortPlayers(
      players.filter(
        player =>
          player.type ===
          "enemy"
      )
    );

  const normal =
    sortPlayers(
      players.filter(
        player =>
          !player.type
      )
    );

  // ==========================================================
  // LAYOUT
  // ==========================================================

  const WIDTH = 1800;

  const SIDE_WIDTH = 360;

  const GAP = 22;

  const LEFT_X = 40;

  const CENTER_X =
    LEFT_X +
    SIDE_WIDTH +
    GAP;

  const CENTER_WIDTH =
    WIDTH -
    SIDE_WIDTH * 2 -
    GAP * 2 -
    80;

  const RIGHT_X =
    CENTER_X +
    CENTER_WIDTH +
    GAP;

  const PANEL_Y = 150;

  const TOP_PADDING = 75;

  const ROW_HEIGHT = 52;

  const normalRows =
    Math.ceil(
      normal.length / 2
    );

  const sideRows =
    Math.max(
      friends.length,
      enemies.length
    );

  const contentRows =
    Math.max(
      normalRows,
      sideRows,
      1
    );

  const panelHeight =
    Math.max(
      180,
      TOP_PADDING +
        contentRows *
          ROW_HEIGHT +
        30
    );

  const HEIGHT =
    PANEL_Y +
    panelHeight +
    45;

  const svg = [];

  // ==========================================================
  // BACKGROUND
  // ==========================================================

  svg.push(`
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="${WIDTH}"
      height="${HEIGHT}"
      viewBox="0 0 ${WIDTH} ${HEIGHT}"
    >

    <rect
      width="${WIDTH}"
      height="${HEIGHT}"
      fill="#06100a"
    />

    <text
      x="${WIDTH / 2}"
      y="48"
      text-anchor="middle"
      font-size="26"
      font-weight="700"
      fill="#55ff55"
      font-family="Arial, sans-serif"
    >Online</text>

    <text
      x="${WIDTH / 2}"
      y="92"
      text-anchor="middle"
      font-size="38"
      font-weight="700"
      fill="#ffffff"
      font-family="Arial, sans-serif"
    >MineBlaze — TAB</text>

    <text
      x="${WIDTH / 2}"
      y="126"
      text-anchor="middle"
      font-size="19"
      fill="#9db5a4"
      font-family="Arial, sans-serif"
    >Server: ${escapeXml(
      MINECRAFT_HOST
    )} • Players: ${players.length}</text>
  `);

  // ==========================================================
  // PANELS
  // ==========================================================

  createPanelBackground(
    svg,
    LEFT_X,
    PANEL_Y,
    SIDE_WIDTH,
    panelHeight,
    "Friend",
    "#55ff55"
  );

  createPanelBackground(
    svg,
    CENTER_X,
    PANEL_Y,
    CENTER_WIDTH,
    panelHeight,
    "Players",
    "#ffffff"
  );

  createPanelBackground(
    svg,
    RIGHT_X,
    PANEL_Y,
    SIDE_WIDTH,
    panelHeight,
    "enemy",
    "#ff5555"
  );

  // ==========================================================
  // FRIENDS
  // ==========================================================

  for (
    let i = 0;
    i < friends.length;
    i++
  ) {
    createPlayerRow(
      svg,
      friends[i],
      LEFT_X + 12,
      PANEL_Y +
        TOP_PADDING +
        i * ROW_HEIGHT,
      SIDE_WIDTH - 24,
      true
    );
  }

  // ==========================================================
  // NORMAL PLAYERS - 2 COLUMNS
  // ==========================================================

  const centerColumnWidth =
    Math.floor(
      (CENTER_WIDTH - 36) /
        2
    );

  for (
    let i = 0;
    i < normal.length;
    i++
  ) {
    const player =
      normal[i];

    const column =
      i % 2;

    const row =
      Math.floor(
        i / 2
      );

    const x =
      CENTER_X +
      12 +
      column *
        (centerColumnWidth +
          12);

    const y =
      PANEL_Y +
      TOP_PADDING +
      row * ROW_HEIGHT;

    createPlayerRow(
      svg,
      player,
      x,
      y,
      centerColumnWidth,
      true
    );
  }

  // ==========================================================
  // ENEMIES
  // ==========================================================

  for (
    let i = 0;
    i < enemies.length;
    i++
  ) {
    createPlayerRow(
      svg,
      enemies[i],
      RIGHT_X + 12,
      PANEL_Y +
        TOP_PADDING +
        i * ROW_HEIGHT,
      SIDE_WIDTH - 24,
      true
    );
  }

  // ==========================================================
  // FOOTER
  // ==========================================================

  svg.push(`
    <text
      x="${WIDTH / 2}"
      y="${HEIGHT - 16}"
      text-anchor="middle"
      font-size="14"
      fill="#5e7565"
      font-family="Arial, sans-serif"
    >MineBlaze KitPvP • Discord Bot</text>

    </svg>
  `);

  return sharp(
    Buffer.from(
      svg.join("\n")
    )
  )
    .png()
    .toBuffer();
}

// ============================================================
// TEXT TAB
// ============================================================

function getTabText() {
  if (!mcBot) {
    return "❌ Minecraft бот не подключён.";
  }

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
            cleanText(
              player.username
            )
          )
      )
      .sort(
        (a, b) =>
          a.username.localeCompare(
            b.username,
            undefined,
            {
              sensitivity:
                "base"
            }
          )
      );

  if (!players.length) {
    return "📋 TAB пуст.";
  }

  const lines =
    players.map(
      player => {
        const ping =
          Number.isFinite(
            Number(
              player.ping
            )
          )
            ? `${Math.round(
                Number(
                  player.ping
                )
              )}ms`
            : "?";

        return `${player.username} — ${ping}`;
      }
    );

  return splitText(
    `📋 **TAB (${players.length})**\n\n${lines.join(
      "\n"
    )}`,
    1900
  );
}

// ============================================================
// SPLIT TEXT
// ============================================================

function splitText(
  text,
  maxLength = 1900
) {
  const result = [];

  let current = "";

  for (
    const line of text.split(
      "\n"
    )
  ) {
    if (
      current.length +
        line.length +
        1 >
      maxLength
    ) {
      if (current) {
        result.push(
          current
        );
      }

      current = line;
    } else {
      current +=
        (current
          ? "\n"
          : "") +
        line;
    }
  }

  if (current) {
    result.push(
      current
    );
  }

  return result;
}

// ============================================================
// VERIFICATION / CAPTCHA
// ============================================================

function extractUrls(text) {
  return (
    text.match(
      /https?:\/\/[^\s<>()]+/gi
    ) || []
  );
}

function looksLikeVerification(
  text
) {
  const lower =
    text.toLowerCase();

  const keywords = [
    "captcha",
    "verify",
    "verification",
    "verification required",
    "robot",
    "anti bot",
    "antibot",
    "подтверд",
    "провер",
    "капча"
  ];

  return keywords.some(
    keyword =>
      lower.includes(
        keyword
      )
  );
}

async function handlePossibleVerification(
  text
) {
  const clean =
    cleanText(text);

  if (
    !looksLikeVerification(
      clean
    )
  ) {
    return false;
  }

  captchaDetected = true;

  shouldReconnect = false;

  const urls =
    extractUrls(clean);

  const urlText =
    urls.length
      ? `\n\n🔗 ${urls.join(
          "\n"
        )}`
      : "";

  await sendDiscordMessage(
    `⚠️ **Обнаружена проверка/капча Minecraft.**\n\n` +
      `Автоматический reconnect остановлен.` +
      urlText
  );

  console.log(
    "[Minecraft] Обнаружена проверка. Reconnect остановлен."
  );

  return true;
}

// ============================================================
// OTHER CLIENT DETECTION
// ============================================================

function looksLikeOtherClientKick(
  text
) {
  const lower =
    text.toLowerCase();

  return (
    lower.includes(
      "с другого майнкрафта"
    ) ||
    lower.includes(
      "другого майнкрафта"
    ) ||
    lower.includes(
      "already logged in"
    ) ||
    lower.includes(
      "logged in from another"
    ) ||
    lower.includes(
      "another minecraft"
    )
  );
}

// ============================================================
// MINECRAFT CONNECT
// ============================================================

async function connectMinecraft() {
  if (isConnecting) {
    return;
  }

  if (
    mcBot &&
    mcBot.player
  ) {
    return;
  }

  isConnecting = true;

  anotherClientDetected =
    false;

  console.log(
    "[Minecraft] Подключение..."
  );

  try {
    const options = {
      host:
        MINECRAFT_HOST,
      port:
        MC_PORT,
      username:
        MINECRAFT_USERNAME,
      auth: "offline"
    };

    if (MC_VERSION) {
      options.version =
        MC_VERSION;
    }

    const bot =
      mineflayer.createBot(
        options
      );

    mcBot = bot;

    // --------------------------------------------------------
    // LOGIN
    // --------------------------------------------------------

    bot.once(
      "login",
      async () => {
        console.log(
          `[Minecraft] Вошёл как ${MINECRAFT_USERNAME}`
        );

        await sleep(3000);

        if (
          SERVER_PASSWORD &&
          SERVER_PASSWORD.trim()
        ) {
          try {
            bot.chat(
              `/login ${SERVER_PASSWORD.trim()}`
            );

            console.log(
              "[Minecraft] Отправлен /login"
            );
          } catch (error) {
            console.log(
              `[Minecraft] Ошибка /login: ${error.message}`
            );
          }
        }

        await sleep(4000);

        if (
          bot &&
          bot.player &&
          shouldReconnect &&
          !captchaDetected &&
          !anotherClientDetected
        ) {
          try {
            bot.chat(
              "/kp2"
            );

            console.log(
              "[Minecraft] Отправлен /kp2"
            );
          } catch (error) {
            console.log(
              `[Minecraft] Ошибка /kp2: ${error.message}`
            );
          }
        }
      }
    );

    // --------------------------------------------------------
    // SPAWN
    // --------------------------------------------------------

    bot.once(
      "spawn",
      () => {
        console.log(
          "[Minecraft] Spawn."
        );

        scheduleAutoLeave();
      }
    );

    // --------------------------------------------------------
    // CHAT
    // --------------------------------------------------------

    bot.on(
      "messagestr",
      async message => {
        const text =
          cleanText(message);

        if (!text) {
          return;
        }

        console.log(
          `[MC] ${text}`
        );

        if (
          looksLikeOtherClientKick(
            text
          )
        ) {
          anotherClientDetected =
            true;

          shouldReconnect =
            false;

          await sendDiscordMessage(
            "⚠️ **Minecraft аккаунт уже используется другим клиентом.**\n\n" +
              "Автоматический reconnect остановлен."
          );

          return;
        }

        await handlePossibleVerification(
          text
        );
      }
    );

    // --------------------------------------------------------
    // GENERIC MESSAGE
    // --------------------------------------------------------

    bot.on(
      "message",
      async message => {
        try {
          const text =
            cleanText(
              message.toString()
            );

          if (!text) {
            return;
          }

          if (
            looksLikeOtherClientKick(
              text
            )
          ) {
            anotherClientDetected =
              true;

            shouldReconnect =
              false;

            await sendDiscordMessage(
              "⚠️ **Minecraft аккаунт уже используется другим клиентом.**\n\n" +
                "Автоматический reconnect остановлен."
            );
          }
        } catch {
          // ignore
        }
      }
    );

    // --------------------------------------------------------
    // KICK
    // --------------------------------------------------------

    bot.on(
      "kicked",
      async reason => {
        const text =
          cleanText(reason);

        console.log(
          `[Minecraft] Kicked: ${text}`
        );

        if (
          looksLikeOtherClientKick(
            text
          )
        ) {
          anotherClientDetected =
            true;

          shouldReconnect =
            false;

          await sendDiscordMessage(
            "⚠️ **Minecraft аккаунт уже используется другим клиентом.**\n\n" +
              "Автоматический reconnect остановлен."
          );

          return;
        }

        await sendDiscordMessage(
          `⚠️ Minecraft бот был кикнут.\n\`${truncateText(
            text,
            1200
          )}\``
        );
      }
    );

    // --------------------------------------------------------
    // ERROR
    // --------------------------------------------------------

    bot.on(
      "error",
      error => {
        console.log(
          `[Minecraft] Error: ${error.message}`
        );
      }
    );

    // --------------------------------------------------------
    // END
    // --------------------------------------------------------

    bot.on(
      "end",
      async reason => {
        console.log(
          `[Minecraft] Соединение закрыто: ${
            reason || "unknown"
          }`
        );

        if (
          mcBot === bot
        ) {
          mcBot = null;
        }

        isConnecting =
          false;

        clearAutoLeaveTimer();

        if (
          shouldReconnect &&
          !captchaDetected &&
          !anotherClientDetected
        ) {
          scheduleReconnect();
        } else if (
          anotherClientDetected
        ) {
          console.log(
            "[Minecraft] Reconnect остановлен: аккаунт используется другим клиентом."
          );
        } else if (
          captchaDetected
        ) {
          console.log(
            "[Minecraft] Reconnect остановлен из-за проверки."
          );
        }
      }
    );

    // --------------------------------------------------------
    // DEATH
    // --------------------------------------------------------

    bot.on(
      "death",
      () => {
        console.log(
          "[Minecraft] Игрок умер."
        );
      }
    );
  } catch (error) {
    console.log(
      `[Minecraft] Ошибка подключения: ${error.message}`
    );

    mcBot = null;

    if (
      shouldReconnect &&
      !captchaDetected &&
      !anotherClientDetected
    ) {
      scheduleReconnect();
    }
  } finally {
    isConnecting =
      false;
  }
}

// ============================================================
// RECONNECT TIMER
// ============================================================

function scheduleReconnect() {
  if (
    reconnectTimer ||
    !shouldReconnect ||
    captchaDetected ||
    anotherClientDetected
  ) {
    return;
  }

  console.log(
    `[Minecraft] Следующая попытка через ${
      RECONNECT_DELAY / 1000
    } сек.`
  );

  reconnectTimer =
    setTimeout(
      async () => {
        reconnectTimer =
          null;

        if (
          shouldReconnect &&
          !captchaDetected &&
          !anotherClientDetected
        ) {
          await connectMinecraft();
        }
      },
      RECONNECT_DELAY
    );
}

// ============================================================
// MANUAL RECONNECT
// ============================================================

async function reconnectMinecraft() {
  captchaDetected =
    false;

  anotherClientDetected =
    false;

  shouldReconnect =
    true;

  if (reconnectTimer) {
    clearTimeout(
      reconnectTimer
    );

    reconnectTimer =
      null;
  }

  if (mcBot) {
    try {
      mcBot.quit(
        "Manual reconnect"
      );
    } catch {
      // ignore
    }

    mcBot = null;
  }

  await sleep(1500);

  await connectMinecraft();
}

// ============================================================
// AUTO LEAVE
// ============================================================

function clearAutoLeaveTimer() {
  if (autoLeaveTimer) {
    clearTimeout(
      autoLeaveTimer
    );

    autoLeaveTimer =
      null;
  }
}

function scheduleAutoLeave() {
  clearAutoLeaveTimer();

  autoLeaveTimer =
    setTimeout(
      () => {
        if (!mcBot) {
          return;
        }

        try {
          mcBot.quit(
            "10 minute auto leave"
          );

          console.log(
            "[Minecraft] Автоматический выход после 10 минут."
          );
        } catch (error) {
          console.log(
            `[Minecraft] Auto leave error: ${error.message}`
          );
        }
      },
      AUTO_LEAVE_TIME
    );
}

// ============================================================
// HELP
// ============================================================

function getHelpText() {
  return [
    "🤖 **MineBlaze Bot**",
    "",
    "`#help` — список команд",
    "`#tab` — TAB в виде картинки",
    "`#kp2` — перейти на KitPvP 2",
    "`#reconnect` — переподключиться и перейти на KP2",
    "",
    "`#friendadd Nick` — добавить друга",
    "`#friendremove Nick` — удалить друга",
    "`#friends` — список друзей",
    "",
    "`#enemyadd Nick` — добавить врага",
    "`#enemyremove Nick` — удалить врага",
    "`#enemies` — список врагов"
  ].join("\n");
}

// ============================================================
// DISCORD COMMANDS
// ============================================================

discord.on(
  "messageCreate",
  async message => {
    try {
      if (
        message.author.bot
      ) {
        return;
      }

      if (
        !getChannelIds().includes(
          message.channel.id
        )
      ) {
        return;
      }

      const content =
        message.content.trim();

      if (
        !content.startsWith(
          PREFIX
        )
      ) {
        return;
      }

      const args =
        content.split(
          /\s+/
        );

      const command =
        args[0]
          .slice(
            PREFIX.length
          )
          .toLowerCase();

      const value =
        args
          .slice(1)
          .join(" ")
          .trim();

      // ------------------------------------------------------
      // HELP
      // ------------------------------------------------------

      if (
        command === "help"
      ) {
        await message.reply(
          getHelpText()
        );

        return;
      }

      // ------------------------------------------------------
      // TAB
      // ------------------------------------------------------

      if (
        command === "tab"
      ) {
        if (!mcBot) {
          await message.reply(
            "⏳ Minecraft бот не подключён. Подключаюсь..."
          );

          await connectMinecraft();

          await sleep(
            7000
          );
        }

        if (!mcBot) {
          await message.reply(
            "❌ Не удалось подключиться к Minecraft."
          );

          return;
        }

        try {
          const image =
            await createTabImage();

          await message.reply({
            files: [
              {
                attachment:
                  image,
                name:
                  "mineblaze-tab.png"
              }
            ]
          });
        } catch (error) {
          console.log(
            `[TAB] Ошибка: ${
              error.stack ||
              error.message
            }`
          );

          await message.reply(
            `❌ Не удалось создать TAB: \`${error.message}\``
          );
        }

        return;
      }

      // ------------------------------------------------------
      // KP2
      // ------------------------------------------------------

      if (
        command === "kp2"
      ) {
        try {
          if (
            mcBot &&
            mcBot.player
          ) {
            mcBot.chat(
              "/kp2"
            );

            await message.reply(
              "🎮 Отправил `/kp2`."
            );
          } else {
            await message.reply(
              "⏳ Minecraft не подключён. Подключаюсь..."
            );

            await connectMinecraft();

            await sleep(
              7000
            );

            if (mcBot) {
              mcBot.chat(
                "/kp2"
              );

              await message.reply(
                "🎮 Подключился и отправил `/kp2`."
              );
            } else {
              await message.reply(
                "❌ Не удалось подключиться."
              );
            }
          }
        } catch (error) {
          await message.reply(
            `❌ Ошибка: \`${error.message}\``
          );
        }

        return;
      }

      // ------------------------------------------------------
      // RECONNECT
      // ------------------------------------------------------

      if (
        command ===
        "reconnect"
      ) {
        await message.reply(
          "🔄 Переподключаю Minecraft..."
        );

        try {
          await reconnectMinecraft();

          await sleep(
            7000
          );

          if (mcBot) {
            try {
              mcBot.chat(
                "/kp2"
              );
            } catch {
              // ignore
            }

            await message.reply(
              "✅ Переподключился и отправил `/kp2`."
            );
          } else {
            await message.reply(
              "⚠️ Reconnect запущен, но Minecraft пока не подключён."
            );
          }
        } catch (error) {
          await message.reply(
            `❌ Ошибка reconnect: \`${error.message}\``
          );
        }

        return;
      }

      // ------------------------------------------------------
      // FRIEND ADD
      // ------------------------------------------------------

      if (
        command ===
        "friendadd"
      ) {
        if (!value) {
          await message.reply(
            "Использование: `#friendadd Nick`"
          );

          return;
        }

        await addTrackedPlayer(
          value,
          "friend"
        );

        await message.reply(
          `🟢 **${value}** добавлен в Friend.`
        );

        return;
      }

      // ------------------------------------------------------
      // FRIEND REMOVE
      // ------------------------------------------------------

      if (
        command ===
        "friendremove"
      ) {
        if (!value) {
          await message.reply(
            "Использование: `#friendremove Nick`"
          );

          return;
        }

        await removeTrackedPlayer(
          value
        );

        await message.reply(
          `🗑️ **${value}** удалён из списка.`
        );

        return;
      }

      // ------------------------------------------------------
      // FRIENDS
      // ------------------------------------------------------

      if (
        command ===
        "friends"
      ) {
        const friends =
          await getTrackedPlayers(
            "friend"
          );

        if (!friends.length) {
          await message.reply(
            "🟢 Friend список пуст."
          );

          return;
        }

        await message.reply(
          `🟢 **Friends (${friends.length})**\n\n` +
            friends
              .map(
                username =>
                  `• ${username}`
              )
              .join("\n")
        );

        return;
      }

      // ------------------------------------------------------
      // ENEMY ADD
      // ------------------------------------------------------

      if (
        command ===
        "enemyadd"
      ) {
        if (!value) {
          await message.reply(
            "Использование: `#enemyadd Nick`"
          );

          return;
        }

        await addTrackedPlayer(
          value,
          "enemy"
        );

        await message.reply(
          `🔴 **${value}** добавлен в enemy.`
        );

        return;
      }

      // ------------------------------------------------------
      // ENEMY REMOVE
      // ------------------------------------------------------

      if (
        command ===
        "enemyremove"
      ) {
        if (!value) {
          await message.reply(
            "Использование: `#enemyremove Nick`"
          );

          return;
        }

        await removeTrackedPlayer(
          value
        );

        await message.reply(
          `🗑️ **${value}** удалён из списка.`
        );

        return;
      }

      // ------------------------------------------------------
      // ENEMIES
      // ------------------------------------------------------

      if (
        command ===
        "enemies"
      ) {
        const enemies =
          await getTrackedPlayers(
            "enemy"
          );

        if (!enemies.length) {
          await message.reply(
            "🔴 Enemy список пуст."
          );

          return;
        }

        await message.reply(
          `🔴 **Enemies (${enemies.length})**\n\n` +
            enemies
              .map(
                username =>
                  `• ${username}`
              )
              .join("\n")
        );

        return;
      }
    } catch (error) {
      console.log(
        `[Discord] Ошибка команды: ${
          error.stack ||
          error.message
        }`
      );

      try {
        await message.reply(
          `❌ Произошла ошибка: \`${error.message}\``
        );
      } catch {
        // ignore
      }
    }
  }
);

// ============================================================
// DISCORD READY
// ============================================================

discord.once(
  "clientReady",
  async () => {
    console.log(
      `[Discord] Бот запущен как ${discord.user.tag}`
    );

    console.log(
      `[Discord] Каналы: ${getChannelIds().join(
        ", "
      )}`
    );

    /*
      Не отправляем стартовое сообщение автоматически,
      чтобы отсутствие доступа к CHANNEL_ID_2
      не создавало лишние ошибки.
    */

    await connectMinecraft();
  }
);

// ============================================================
// RENDER HTTP SERVER
// ============================================================

const server =
  http.createServer(
    (req, res) => {
      res.writeHead(
        200,
        {
          "Content-Type":
            "text/plain; charset=utf-8"
        }
      );

      res.end(
        "MineBlaze Discord Bot is running."
      );
    }
  );

server.listen(
  Number(
    PORT || 3000
  ),
  "0.0.0.0",
  () => {
    console.log(
      `[HTTP] Server listening on port ${
        PORT || 3000
      }`
    );
  }
);

// ============================================================
// START
// ============================================================

async function start() {
  console.log(
    "======================================"
  );

  console.log(
    " MineBlaze Discord + Minecraft Bot"
  );

  console.log(
    "======================================"
  );

  await initDatabase();

  await discord.login(
    DISCORD_TOKEN
  );
}

// ============================================================
// SHUTDOWN
// ============================================================

async function shutdown() {
  console.log(
    "[System] Выключение..."
  );

  shouldReconnect =
    false;

  if (reconnectTimer) {
    clearTimeout(
      reconnectTimer
    );

    reconnectTimer =
      null;
  }

  clearAutoLeaveTimer();

  if (mcBot) {
    try {
      mcBot.quit(
        "Bot shutdown"
      );
    } catch {
      // ignore
    }
  }

  try {
    await pool.end();
  } catch {
    // ignore
  }

  try {
    discord.destroy();
  } catch {
    // ignore
  }

  server.close(
    () => {
      process.exit(0);
    }
  );

  setTimeout(
    () => {
      process.exit(0);
    },
    3000
  );
}

process.on(
  "SIGINT",
  shutdown
);

process.on(
  "SIGTERM",
  shutdown
);

// ============================================================
// START BOT
// ============================================================

start().catch(
  error => {
    console.error(
      "[System] Критическая ошибка:",
      error
    );

    process.exit(1);
  }
);
