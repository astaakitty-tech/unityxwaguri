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

// ============================================================
// CHECK ENV
// ============================================================

if (!DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN не задан");
}

if (!CHANNEL_ID) {
  throw new Error("CHANNEL_ID не задан");
}

if (!MINECRAFT_HOST || !MINECRAFT_USERNAME) {
  throw new Error("MineBlaze env не заполнен");
}

if (!DEXLAND_HOST || !DEXLAND_USERNAME) {
  throw new Error("DexLand env не заполнен");
}

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL не задан");
}

// ============================================================
// SETTINGS
// ============================================================

const PREFIX = "#";

const MC_PORT = Number(MINECRAFT_PORT || 25565);
const DEX_PORT = Number(DEXLAND_PORT || 25565);

const MC_VERSION =
  MINECRAFT_VERSION && MINECRAFT_VERSION.trim()
    ? MINECRAFT_VERSION.trim()
    : false;

const DEX_VERSION =
  DEXLAND_VERSION && DEXLAND_VERSION.trim()
    ? DEXLAND_VERSION.trim()
    : false;

const RECONNECT_DELAY = 10_000;
const AUTO_LEAVE_TIME = 10 * 60 * 1000;
const SKIN_CACHE_TIME = 30 * 60 * 1000;

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

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracked_players (
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

  console.log("[DB] База готова");
}

async function addTrackedPlayer(username, type) {
  username = username.trim();

  if (!username) return;

  if (type !== "friend" && type !== "enemy") {
    throw new Error("Неверный тип игрока");
  }

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

async function removeTrackedPlayer(username) {
  username = username.trim();

  if (!username) return;

  await pool.query(
    `
    DELETE FROM tracked_players
    WHERE LOWER(username) = LOWER($1)
    `,
    [username]
  );
}

async function getTrackedPlayers(type) {
  const result = await pool.query(
    `
    SELECT username
    FROM tracked_players
    WHERE type = $1
    ORDER BY LOWER(username)
    `,
    [type]
  );

  return result.rows.map(row => row.username);
}

async function getTrackedMap() {
  const result = await pool.query(`
    SELECT username, type
    FROM tracked_players
  `);

  const map = new Map();

  for (const row of result.rows) {
    map.set(row.username.toLowerCase(), row.type);
  }

  return map;
}

// ============================================================
// DISCORD CHANNEL
// ============================================================

async function getDiscordChannel() {
  try {
    const channel = await discord.channels.fetch(CHANNEL_ID);

    if (!channel || !channel.isTextBased()) {
      return null;
    }

    return channel;
  } catch (error) {
    console.log(
      `[Discord] Ошибка получения канала: ${error.message}`
    );

    return null;
  }
}

async function sendDiscordMessage(text) {
  const channel = await getDiscordChannel();

  if (!channel) return;

  try {
    await channel.send(text);
  } catch (error) {
    console.log(
      `[Discord] Ошибка отправки: ${error.message}`
    );
  }
}

// ============================================================
// UTILS
// ============================================================

function cleanText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value
      .replace(/§[0-9a-fk-or]/gi, "")
      .replace(/\u001b\[[0-9;]*m/g, "")
      .trim();
  }

  try {
    return cleanText(JSON.stringify(value));
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

function truncateText(text, maxLength) {
  text = String(text);

  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength - 1) + "…";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// BOT STATES
// ============================================================

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

// ============================================================
// NAME MC CACHE
// ============================================================

const skinCache = new Map();

// ============================================================
// NAMEMC
// ============================================================

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
    const profileUrl =
      `https://ru.namemc.com/profile/${encodeURIComponent(username)}`;

    const response = await fetch(profileUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8"
      }
    });

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
      throw new Error("Скин не найден в профиле NameMC");
    }

    const skinHash = matches[0][1];

    const skinUrl =
      `https://s.namemc.com/i/${skinHash}.png`;

    const skinResponse = await fetch(skinUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

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

// ============================================================
// PLAYER HEAD
// ============================================================

async function getPlayerHead(username) {
  const skin = await getNameMcSkin(username);

  if (!skin) {
    return null;
  }

  try {
    const face = await sharp(skin)
      .extract({
        left: 8,
        top: 8,
        width: 8,
        height: 8
      })
      .resize(40, 40, {
        kernel: "nearest"
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
        kernel: "nearest"
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
      `[NameMC] Ошибка головы ${username}: ${error.message}`
    );

    return null;
  }
}

// ============================================================
// PING COLOR
// ============================================================

function getPingColor(ping) {
  const value = Number(ping);

  if (!Number.isFinite(value)) {
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
// PLAYER ROW
// ============================================================

function createPlayerRow(
  svg,
  player,
  x,
  y,
  width,
  compact = false
) {
  const rowHeight = compact ? 44 : 52;
  const headSize = compact ? 34 : 40;

  const username = truncateText(
    player.username,
    compact ? 18 : 22
  );

  const ping =
    Number.isFinite(Number(player.ping))
      ? `${Math.round(Number(player.ping))}ms`
      : "?";

  const pingColor = getPingColor(player.ping);

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
// TAB IMAGE
// ============================================================

async function createTabImage(bot, serverName, serverHost) {
  if (!bot) {
    throw new Error("Minecraft бот не подключён");
  }

  const tracked = await getTrackedMap();

  const players = Object.values(bot.players || {})
    .filter(
      player =>
        player &&
        player.username
    )
    .filter(
      player =>
        !/staff\s+in\s+vanish/i.test(
          cleanText(player.username)
        )
    )
    .sort(
      (a, b) =>
        a.username.localeCompare(
          b.username,
          undefined,
          {
            sensitivity: "base"
          }
        )
    );

  const prepared = [];

  for (const player of players) {
    const type =
      tracked.get(player.username.toLowerCase()) || "normal";

    prepared.push({
      username: player.username,
      ping: player.ping,
      type,
      head: await getPlayerHead(player.username)
    });
  }

  const friends = prepared.filter(
    p => p.type === "friend"
  );

  const enemies = prepared.filter(
    p => p.type === "enemy"
  );

  const normal = prepared.filter(
    p => p.type === "normal"
  );

  const WIDTH = 1500;
  const HEIGHT = 950;

  const SIDE_WIDTH = 330;
  const CENTER_WIDTH = 770;

  const LEFT_X = 30;
  const CENTER_X = 365;
  const RIGHT_X = 1140;

  const PANEL_Y = 160;

  const TOP_PADDING = 65;
  const ROW_HEIGHT = 50;

  const maxRows = Math.max(
    friends.length,
    enemies.length,
    Math.ceil(normal.length / 2),
    1
  );

  const panelHeight =
    TOP_PADDING +
    maxRows * ROW_HEIGHT +
    25;

  const svg = [];

  svg.push(`
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="${WIDTH}"
      height="${Math.max(
        HEIGHT,
        PANEL_Y + panelHeight + 50
      )}"
      viewBox="0 0 ${WIDTH} ${Math.max(
        HEIGHT,
        PANEL_Y + panelHeight + 50
      )}"
    >

    <rect
      width="${WIDTH}"
      height="${Math.max(
        HEIGHT,
        PANEL_Y + panelHeight + 50
      )}"
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
    >${escapeXml(serverName)} — TAB</text>

    <text
      x="${WIDTH / 2}"
      y="126"
      text-anchor="middle"
      font-size="19"
      fill="#9db5a4"
      font-family="Arial, sans-serif"
    >Server: ${escapeXml(
      serverHost
    )} • Players: ${players.length}</text>
  `);

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
    "Enemy",
    "#ff5555"
  );

  for (let i = 0; i < friends.length; i++) {
    createPlayerRow(
      svg,
      friends[i],
      LEFT_X + 12,
      PANEL_Y + TOP_PADDING + i * ROW_HEIGHT,
      SIDE_WIDTH - 24,
      true
    );
  }

  const centerColumnWidth =
    Math.floor((CENTER_WIDTH - 36) / 2);

  for (let i = 0; i < normal.length; i++) {
    const player = normal[i];

    const column = i % 2;
    const row = Math.floor(i / 2);

    const x =
      CENTER_X +
      12 +
      column * (centerColumnWidth + 12);

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

  for (let i = 0; i < enemies.length; i++) {
    createPlayerRow(
      svg,
      enemies[i],
      RIGHT_X + 12,
      PANEL_Y + TOP_PADDING + i * ROW_HEIGHT,
      SIDE_WIDTH - 24,
      true
    );
  }

  svg.push(`
    <text
      x="${WIDTH / 2}"
      y="${Math.max(
        HEIGHT,
        PANEL_Y + panelHeight + 50
      ) - 16}"
      text-anchor="middle"
      font-size="14"
      fill="#5e7565"
      font-family="Arial, sans-serif"
    >${escapeXml(
      serverName
    )} • Discord Bot</text>

    </svg>
  `);

  return sharp(
    Buffer.from(svg.join("\n"))
  )
    .png()
    .toBuffer();
}

// ============================================================
// VERIFICATION
// ============================================================

function extractUrls(text) {
  return (
    text.match(
      /https?:\/\/[^\s<>()]+/gi
    ) || []
  );
}

function looksLikeVerification(text) {
  const lower = text.toLowerCase();

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
      lower.includes(keyword)
  );
}

function looksLikeOtherClient(text) {
  const lower = text.toLowerCase();

  return (
    lower.includes("с другого майнкрафта") ||
    lower.includes("другого майнкрафта") ||
    lower.includes("already logged in") ||
    lower.includes("logged in from another") ||
    lower.includes("another minecraft")
  );
}

async function handleMinecraftMessage(key, text) {
  const s = bots[key];
  const name =
    key === "mineblaze"
      ? "MineBlaze"
      : "DexLand";

  const clean = cleanText(text);

  if (!clean) return;

  console.log(`[${name}] ${clean}`);

  if (looksLikeOtherClient(clean)) {
    s.other = true;
    s.shouldReconnect = false;

    await sendDiscordMessage(
      `⚠️ **${name}: обнаружен вход с другого Minecraft-клиента.**\nАвтоматический reconnect остановлен.`
    );

    return;
  }

  if (looksLikeVerification(clean)) {
    s.captcha = true;
    s.shouldReconnect = false;

    const urls = extractUrls(clean);

    const urlText = urls.length
      ? `\n\n🔗 ${urls.join("\n")}`
      : "";

    await sendDiscordMessage(
      `⚠️ **${name}: обнаружена проверка/капча.**\n\nАвтоматический reconnect остановлен.${urlText}`
    );

    return;
  }
}

// ============================================================
// AUTO LEAVE
// ============================================================

function clearAutoLeaveTimer(key) {
  const s = bots[key];

  if (s.autoLeaveTimer) {
    clearTimeout(s.autoLeaveTimer);
    s.autoLeaveTimer = null;
  }
}

function scheduleAutoLeave(key) {
  const s = bots[key];

  clearAutoLeaveTimer(key);

  s.autoLeaveTimer = setTimeout(() => {
    if (!s.bot) return;

    try {
      s.bot.quit("10 minute auto leave");

      console.log(
        `[${key}] Автоматический выход после 10 минут.`
      );
    } catch (error) {
      console.log(
        `[${key}] Auto leave error: ${error.message}`
      );
    }
  }, AUTO_LEAVE_TIME);
}

// ============================================================
// RECONNECT
// ============================================================

function scheduleReconnect(key) {
  const s = bots[key];

  if (
    s.reconnectTimer ||
    !s.shouldReconnect ||
    s.captcha ||
    s.other
  ) {
    return;
  }

  const name =
    key === "mineblaze"
      ? "MineBlaze"
      : "DexLand";

  console.log(
    `[${name}] Следующая попытка через ${
      RECONNECT_DELAY / 1000
    } сек.`
  );

  s.reconnectTimer = setTimeout(
    async () => {
      s.reconnectTimer = null;

      if (
        s.shouldReconnect &&
        !s.captcha &&
        !s.other
      ) {
        await connectServer(key);
      }
    },
    RECONNECT_DELAY
  );
}

// ============================================================
// CONNECT SERVER
// ============================================================

async function connectServer(key) {
  const s = bots[key];

  if (
    s.connecting ||
    (s.bot && s.bot.player)
  ) {
    return;
  }

  s.connecting = true;
  s.other = false;

  const mb = key === "mineblaze";

  const host = mb
    ? MINECRAFT_HOST
    : DEXLAND_HOST;

  const port = mb
    ? MC_PORT
    : DEX_PORT;

  const username = mb
    ? MINECRAFT_USERNAME
    : DEXLAND_USERNAME;

  const version = mb
    ? MC_VERSION
    : DEX_VERSION;

  const password = mb
    ? SERVER_PASSWORD
    : DEXLAND_PASSWORD;

  const name = mb
    ? "MineBlaze"
    : "DexLand";

  console.log(
    `[${name}] Подключение к ${host}:${port}...`
  );

  try {
    const options = {
      host,
      port,
      username,
      auth: "offline"
    };

    if (version) {
      options.version = version;
    }

    const bot = mineflayer.createBot(options);

    s.bot = bot;

    // --------------------------------------------------------
    // LOGIN
    // --------------------------------------------------------

    bot.once("login", async () => {
      console.log(
        `[${name}] Вошёл как ${username}`
      );

      await sleep(3000);

      if (
        password &&
        password.trim()
      ) {
        try {
          bot.chat(
            `/login ${password.trim()}`
          );

          console.log(
            `[${name}] Отправлен /login`
          );
        } catch (error) {
          console.log(
            `[${name}] Ошибка /login: ${error.message}`
          );
        }
      }

      // Ждём авторизацию
      await sleep(4000);

      if (
        bot &&
        bot.player &&
        s.shouldReconnect &&
        !s.captcha &&
        !s.other
      ) {
        try {
          // ================================
          // ВАЖНО:
          // MineBlaze -> /kp2
          // DexLand  -> /kp1
          // ================================

          const modeCommand =
            mb ? "/kp2" : "/kp1";

          bot.chat(modeCommand);

          console.log(
            `[${name}] Отправлен ${modeCommand}`
          );
        } catch (error) {
          console.log(
            `[${name}] Ошибка перехода в режим: ${error.message}`
          );
        }
      }
    });

    // --------------------------------------------------------
    // SPAWN
    // --------------------------------------------------------

    bot.once("spawn", () => {
      console.log(
        `[${name}] Spawn.`
      );

      scheduleAutoLeave(key);
    });

    // --------------------------------------------------------
    // CHAT
    // --------------------------------------------------------

    bot.on(
      "messagestr",
      async message => {
        await handleMinecraftMessage(
          key,
          message
        );
      }
    );

    // --------------------------------------------------------
    // KICK
    // --------------------------------------------------------

    bot.on("kicked", async reason => {
      const text = cleanText(reason);

      console.log(
        `[${name}] Kicked: ${text}`
      );

      await handleMinecraftMessage(
        key,
        text
      );
    });

    // --------------------------------------------------------
    // ERROR
    // --------------------------------------------------------

    bot.on("error", error => {
      console.log(
        `[${name}] Error: ${error.message}`
      );
    });

    // --------------------------------------------------------
    // END
    // --------------------------------------------------------

    bot.on("end", () => {
      console.log(
        `[${name}] Соединение закрыто.`
      );

      clearAutoLeaveTimer(key);

      s.bot = null;
      s.connecting = false;

      if (
        s.shouldReconnect &&
        !s.captcha &&
        !s.other
      ) {
        scheduleReconnect(key);
      }
    });

    s.connecting = false;

  } catch (error) {
    console.log(
      `[${name}] Ошибка подключения: ${error.message}`
    );

    s.bot = null;
    s.connecting = false;

    if (
      s.shouldReconnect &&
      !s.captcha &&
      !s.other
    ) {
      scheduleReconnect(key);
    }
  }
}

// ============================================================
// MANUAL RECONNECT
// ============================================================

async function reconnectServer(key) {
  const s = bots[key];

  s.captcha = false;
  s.other = false;
  s.shouldReconnect = true;

  if (s.reconnectTimer) {
    clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
  }

  if (s.bot) {
    try {
      s.bot.quit("Manual reconnect");
    } catch {
      // ignore
    }

    s.bot = null;
  }

  await sleep(1500);

  await connectServer(key);
}

async function reconnectAll() {
  await Promise.all([
    reconnectServer("mineblaze"),
    reconnectServer("dexland")
  ]);
}

// ============================================================
// HELP
// ============================================================

function getHelpText() {
  return [
    "🤖 **Minecraft Discord Bot**",
    "",
    "`#help` — список команд",
    "`#tab` — TAB MineBlaze + DexLand",
    "`#kp2` — перейти на KitPvP 2 MineBlaze",
    "`#reconnect` — переподключить оба сервера",
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
      if (message.author.bot) {
        return;
      }

      if (message.channel.id !== CHANNEL_ID) {
        return;
      }

      const content =
        message.content.trim();

      if (!content.startsWith(PREFIX)) {
        return;
      }

      const args =
        content.split(/\s+/);

      const command =
        args[0]
          .slice(PREFIX.length)
          .toLowerCase();

      const value =
        args
          .slice(1)
          .join(" ")
          .trim();

      // ------------------------------------------------------
      // HELP
      // ------------------------------------------------------

      if (command === "help") {
        await message.reply(
          getHelpText()
        );

        return;
      }

      // ------------------------------------------------------
      // TAB
      // ------------------------------------------------------

      if (command === "tab") {
        try {
          await message.reply(
            "⏳ Получаю TAB с MineBlaze и DexLand..."
          );

          if (
            !bots.mineblaze.bot ||
            !bots.mineblaze.bot.player
          ) {
            await connectServer("mineblaze");
          }

          if (
            !bots.dexland.bot ||
            !bots.dexland.bot.player
          ) {
            await connectServer("dexland");
          }

          await sleep(7000);

          const files = [];

          if (
            bots.mineblaze.bot &&
            bots.mineblaze.bot.player
          ) {
            const image =
              await createTabImage(
                bots.mineblaze.bot,
                "MineBlaze",
                MINECRAFT_HOST
              );

            files.push({
              attachment: image,
              name: "mineblaze-tab.png"
            });
          }

          if (
            bots.dexland.bot &&
            bots.dexland.bot.player
          ) {
            const image =
              await createTabImage(
                bots.dexland.bot,
                "DexLand",
                DEXLAND_HOST
              );

            files.push({
              attachment: image,
              name: "dexland-tab.png"
            });
          }

          if (!files.length) {
            await message.reply(
              "❌ Ни один Minecraft-бот не подключён."
            );

            return;
          }

          await message.reply({
            files
          });

        } catch (error) {
          console.log(
            `[TAB] Ошибка: ${error.stack || error.message}`
          );

          await message.reply(
            `❌ Ошибка TAB: \`${error.message}\``
          );
        }

        return;
      }

      // ------------------------------------------------------
      // KP2
      // ------------------------------------------------------

      if (command === "kp2") {
        const bot =
          bots.mineblaze.bot;

        if (
          bot &&
          bot.player
        ) {
          bot.chat("/kp2");

          await message.reply(
            "🎮 MineBlaze: отправил `/kp2`."
          );
        } else {
          await message.reply(
            "⏳ MineBlaze не подключён. Подключаю..."
          );

          await connectServer("mineblaze");

          await sleep(7000);

          if (
            bots.mineblaze.bot &&
            bots.mineblaze.bot.player
          ) {
            bots.mineblaze.bot.chat("/kp2");

            await message.reply(
              "🎮 MineBlaze подключён, отправил `/kp2`."
            );
          } else {
            await message.reply(
              "❌ Не удалось подключиться к MineBlaze."
            );
          }
        }

        return;
      }

      // ------------------------------------------------------
      // RECONNECT
      // ------------------------------------------------------

      if (command === "reconnect") {
        await message.reply(
          "🔄 Переподключаю MineBlaze и DexLand..."
        );

        try {
          await reconnectAll();

          await sleep(7000);

          await message.reply(
            "✅ Переподключение запущено для обоих серверов.\nMineBlaze → `/kp2`\nDexLand → `/kp1`"
          );
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

      if (command === "friendadd") {
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

      if (command === "friendremove") {
        if (!value) {
          await message.reply(
            "Использование: `#friendremove Nick`"
          );

          return;
        }

        await removeTrackedPlayer(value);

        await message.reply(
          `🗑️ **${value}** удалён из списка.`
        );

        return;
      }

      // ------------------------------------------------------
      // FRIENDS
      // ------------------------------------------------------

      if (command === "friends") {
        const friends =
          await getTrackedPlayers("friend");

        if (!friends.length) {
          await message.reply(
            "🟢 Friend список пуст."
          );

          return;
        }

        await message.reply(
          `🟢 **Friends (${friends.length})**\n\n` +
          friends
            .map(username => `• ${username}`)
            .join("\n")
        );

        return;
      }

      // ------------------------------------------------------
      // ENEMY ADD
      // ------------------------------------------------------

      if (command === "enemyadd") {
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
          `🔴 **${value}** добавлен в Enemy.`
        );

        return;
      }

      // ------------------------------------------------------
      // ENEMY REMOVE
      // ------------------------------------------------------

      if (command === "enemyremove") {
        if (!value) {
          await message.reply(
            "Использование: `#enemyremove Nick`"
          );

          return;
        }

        await removeTrackedPlayer(value);

        await message.reply(
          `🗑️ **${value}** удалён из списка.`
        );

        return;
      }

      // ------------------------------------------------------
      // ENEMIES
      // ------------------------------------------------------

      if (command === "enemies") {
        const enemies =
          await getTrackedPlayers("enemy");

        if (!enemies.length) {
          await message.reply(
            "🔴 Enemy список пуст."
          );

          return;
        }

        await message.reply(
          `🔴 **Enemies (${enemies.length})**\n\n` +
          enemies
            .map(username => `• ${username}`)
            .join("\n")
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
      `[Discord] Канал: ${CHANNEL_ID}`
    );

    await connectServer("mineblaze");
    await connectServer("dexland");
  }
);

// ============================================================
// HTTP SERVER FOR RENDER
// ============================================================

const server = http.createServer(
  (req, res) => {
    res.writeHead(200, {
      "Content-Type":
        "text/plain; charset=utf-8"
    });

    res.end(
      "Minecraft Discord Bot is running."
    );
  }
);

server.listen(
  Number(PORT || 3000),
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
    " Minecraft Discord Bot"
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

  for (const key of [
    "mineblaze",
    "dexland"
  ]) {
    const s = bots[key];

    s.shouldReconnect = false;

    if (s.reconnectTimer) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = null;
    }

    clearAutoLeaveTimer(key);

    if (s.bot) {
      try {
        s.bot.quit("Shutdown");
      } catch {
        // ignore
      }
    }

    s.bot = null;
  }

  try {
    await discord.destroy();
  } catch {
    // ignore
  }

  try {
    await pool.end();
  } catch {
    // ignore
  }

  try {
    server.close();
  } catch {
    // ignore
  }

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch(error => {
  console.error(
    "[System] Критическая ошибка:",
    error
  );

  process.exit(1);
});
