const {
  Client,
  GatewayIntentBits,
  AttachmentBuilder
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
// ПРОВЕРКА ENV
// ============================================================

const requiredEnv = [
  "DISCORD_TOKEN",
  "CHANNEL_ID",

  "MINECRAFT_HOST",
  "MINECRAFT_PORT",
  "MINECRAFT_USERNAME",

  "DEXLAND_HOST",
  "DEXLAND_PORT",
  "DEXLAND_USERNAME",

  "DATABASE_URL"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`❌ Не задан ENV: ${key}`);
    process.exit(1);
  }
}

// ============================================================
// НАСТРОЙКИ
// ============================================================

const MC_PORT = Number(MINECRAFT_PORT);
const DEX_PORT = Number(DEXLAND_PORT);

const PREFIX = "#";

const RECONNECT_DELAY = 30000;
const AUTO_LEAVE_TIME = 10 * 60 * 1000;

// Время ожидания после /kp2 или /kp1
const MODE_WAIT_TIME = 8000;

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
// POSTGRESQL
// ============================================================

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ============================================================
// СОСТОЯНИЯ
// ============================================================

const states = {
  mineblaze: {
    bot: null,
    isConnecting: false,
    reconnectTimer: null,
    autoLeaveTimer: null,

    shouldReconnect: true,

    captchaDetected: false,
    anotherClientDetected: false,

    lastMessages: []
  },

  dexland: {
    bot: null,
    isConnecting: false,
    reconnectTimer: null,
    autoLeaveTimer: null,

    shouldReconnect: true,

    captchaDetected: false,
    anotherClientDetected: false,

    lastMessages: []
  }
};

// ============================================================
// IP BAN
// ============================================================

let ipBanDetected = false;

// ============================================================
// HTTP ДЛЯ RENDER
// ============================================================

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8"
  });

  res.end("Minecraft Discord Bot is running.\n");
});

server.listen(
  Number(PORT) || 10000,
  "0.0.0.0",
  () => {
    console.log(
      `🌐 HTTP server запущен на порту ${
        Number(PORT) || 10000
      }`
    );
  }
);

// ============================================================
// UTIL
// ============================================================

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function truncateText(text, maxLength = 1900) {
  text = String(text);

  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength - 1) + "…";
}

function cleanText(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value)
    .replace(/§[0-9a-fk-or]/gi, "")
    .replace(/\u00a7[0-9a-fk-or]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getChannelIds() {
  return [
    String(CHANNEL_ID)
  ];
}

// ============================================================
// DISCORD MESSAGE
// ============================================================

async function sendDiscordMessage(text) {
  try {
    const channel =
      await discord.channels.fetch(
        CHANNEL_ID
      );

    if (!channel) {
      return;
    }

    await channel.send(
      truncateText(text)
    );

  } catch (error) {
    console.log(
      `[Discord] Ошибка отправки: ${error.message}`
    );
  }
}

// ============================================================
// DATABASE
// ============================================================

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracked_players (
      username TEXT PRIMARY KEY,
      type TEXT NOT NULL
    )
  `);

  console.log(
    "🗄️ PostgreSQL готов."
  );
}

// ============================================================
// FRIENDS / ENEMIES
// ============================================================

async function addTrackedPlayer(
  username,
  type
) {
  username =
    String(username).trim();

  if (!username) {
    return;
  }

  await pool.query(
    `
    INSERT INTO tracked_players
      (username, type)
    VALUES
      ($1, $2)
    ON CONFLICT (username)
    DO UPDATE SET
      type = EXCLUDED.type
    `,
    [
      username,
      type
    ]
  );
}

async function removeTrackedPlayer(
  username
) {
  await pool.query(
    `
    DELETE FROM tracked_players
    WHERE LOWER(username) = LOWER($1)
    `,
    [username]
  );
}

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
// ПРОВЕРКА СПИСКА
// ============================================================

async function getTrackedSets() {
  const friends =
    await getTrackedPlayers(
      "friend"
    );

  const enemies =
    await getTrackedPlayers(
      "enemy"
    );

  return {
    friends: new Set(
      friends.map(
        x => x.toLowerCase()
      )
    ),

    enemies: new Set(
      enemies.map(
        x => x.toLowerCase()
      )
    )
  };
}

// ============================================================
// CAPTCHA / ПРОВЕРКА
// ============================================================

function looksLikeVerification(
  text
) {
  const lower =
    String(text).toLowerCase();

  const words = [
    "captcha",
    "verification",
    "verify",
    "anti bot",
    "antibot",
    "robot",
    "подтверд",
    "провер",
    "капча"
  ];

  return words.some(
    word =>
      lower.includes(word)
  );
}

async function handlePossibleVerification(
  key,
  text
) {
  if (
    !looksLikeVerification(text)
  ) {
    return false;
  }

  const state =
    states[key];

  state.captchaDetected = true;
  state.shouldReconnect = false;

  console.log(
    `[${key}] Обнаружена проверка. Reconnect остановлен.`
  );

  await sendDiscordMessage(
    `⚠️ **${key}: обнаружена проверка/капча.**\n` +
    `Автоматический reconnect остановлен.`
  );

  return true;
}

// ============================================================
// BAN
// ============================================================

function looksLikeBan(text) {
  const lower =
    String(text).toLowerCase();

  return (
    lower.includes(
      "вы забанены по ip"
    ) ||
    lower.includes(
      "забанены по ip"
    ) ||
    lower.includes(
      "бан по ip"
    ) ||
    lower.includes(
      "banned by ip"
    ) ||
    lower.includes(
      "ip ban"
    ) ||
    lower.includes(
      "подозрение в использовании читов"
    )
  );
}

async function stopAllMinecraftReconnects(
  reason
) {
  if (ipBanDetected) {
    return;
  }

  ipBanDetected = true;

  console.log(
    "🛑 ОБНАРУЖЕН IP-БАН. Reconnect остановлен."
  );

  for (const key of [
    "mineblaze",
    "dexland"
  ]) {
    const state =
      states[key];

    state.shouldReconnect =
      false;

    if (state.reconnectTimer) {
      clearTimeout(
        state.reconnectTimer
      );

      state.reconnectTimer = null;
    }
  }

  await sendDiscordMessage(
    "🛑 **Обнаружен IP-бан Minecraft.**\n\n" +
    "Автоматический reconnect остановлен.\n\n" +
    `\`${truncateText(
      reason,
      1000
    )}\``
  );
}

// ============================================================
// OTHER CLIENT
// ============================================================

function looksLikeOtherClient(
  text
) {
  const lower =
    String(text).toLowerCase();

  return (
    lower.includes(
      "already logged in"
    ) ||
    lower.includes(
      "logged in from another"
    ) ||
    lower.includes(
      "another minecraft"
    ) ||
    lower.includes(
      "другого майнкрафта"
    )
  );
}

// ============================================================
// AUTO LEAVE
// ============================================================

function clearAutoLeaveTimer(key) {
  const state =
    states[key];

  if (
    state.autoLeaveTimer
  ) {
    clearTimeout(
      state.autoLeaveTimer
    );

    state.autoLeaveTimer = null;
  }
}

function scheduleAutoLeave(key) {
  const state =
    states[key];

  clearAutoLeaveTimer(key);

  state.autoLeaveTimer =
    setTimeout(() => {
      if (!state.bot) {
        return;
      }

      try {
        state.bot.quit(
          "10 minute auto leave"
        );

        console.log(
          `[${key}] Выход после 10 минут.`
        );

      } catch {
        // ignore
      }
    }, AUTO_LEAVE_TIME);
}

// ============================================================
// ОТПРАВКА КОМАНДЫ РЕЖИМА
// ============================================================

async function enterKitPvP(key) {
  const state =
    states[key];

  if (
    !state.bot ||
    !state.bot.player
  ) {
    return false;
  }

  const isMineBlaze =
    key === "mineblaze";

  const command =
    isMineBlaze
      ? "/kp2"
      : "/kp1";

  const serverName =
    isMineBlaze
      ? "MineBlaze"
      : "DexLand";

  console.log(
    `[${serverName}] Отправляю ${command}`
  );

  try {
    state.bot.chat(
      command
    );

    await sleep(
      MODE_WAIT_TIME
    );

    if (
      ipBanDetected ||
      state.captchaDetected ||
      state.anotherClientDetected
    ) {
      return false;
    }

    return Boolean(
      state.bot &&
      state.bot.player
    );

  } catch (error) {
    console.log(
      `[${serverName}] Ошибка ${command}: ${error.message}`
    );

    return false;
  }
}

// ============================================================
// CONNECT
// ============================================================

async function connectServer(key) {
  const state =
    states[key];

  if (ipBanDetected) {
    console.log(
      `[${key}] Подключение запрещено: IP-ban.`
    );

    return false;
  }

  if (
    state.isConnecting
  ) {
    return false;
  }

  if (
    state.bot &&
    state.bot.player
  ) {
    return true;
  }

  state.isConnecting =
    true;

  state.captchaDetected =
    false;

  state.anotherClientDetected =
    false;

  const isMineBlaze =
    key === "mineblaze";

  const host =
    isMineBlaze
      ? MINECRAFT_HOST
      : DEXLAND_HOST;

  const port =
    isMineBlaze
      ? MC_PORT
      : DEX_PORT;

  const username =
    isMineBlaze
      ? MINECRAFT_USERNAME
      : DEXLAND_USERNAME;

  const version =
    isMineBlaze
      ? MINECRAFT_VERSION
      : DEXLAND_VERSION;

  const password =
    isMineBlaze
      ? SERVER_PASSWORD
      : DEXLAND_PASSWORD;

  const serverName =
    isMineBlaze
      ? "MineBlaze"
      : "DexLand";

  console.log(
    `[${serverName}] Подключение к ${host}:${port}...`
  );

  try {
    const options = {
      host,
      port,
      username,
      auth: "offline"
    };

    if (version) {
      options.version =
        version;
    }

    const bot =
      mineflayer.createBot(
        options
      );

    state.bot =
      bot;

    // ========================================================
    // LOGIN
    // ========================================================

    bot.once(
      "login",
      async () => {
        console.log(
          `[${serverName}] Login: ${username}`
        );

        await sleep(3000);

        if (
          ipBanDetected ||
          !state.shouldReconnect
        ) {
          return;
        }

        if (
          password &&
          password.trim()
        ) {
          try {
            bot.chat(
              `/login ${password.trim()}`
            );

            console.log(
              `[${serverName}] Отправлен /login`
            );

          } catch (error) {
            console.log(
              `[${serverName}] /login error: ${error.message}`
            );
          }
        }

        /*
         * Даём серверу время обработать авторизацию.
         */
        await sleep(4500);

        if (
          ipBanDetected ||
          state.captchaDetected ||
          state.anotherClientDetected
        ) {
          return;
        }

        /*
         * После авторизации отправляем
         * нужный режим.
         */
        await enterKitPvP(
          key
        );
      }
    );

    // ========================================================
    // SPAWN
    // ========================================================

    bot.once(
      "spawn",
      () => {
        console.log(
          `[${serverName}] Spawn.`
        );

        scheduleAutoLeave(
          key
        );
      }
    );

    // ========================================================
    // CHAT
    // ========================================================

    bot.on(
      "messagestr",
      async message => {
        const text =
          cleanText(message);

        if (!text) {
          return;
        }

        console.log(
          `[${serverName}] ${text}`
        );

        state.lastMessages.push(
          text
        );

        if (
          state.lastMessages.length >
          30
        ) {
          state.lastMessages.shift();
        }

        if (
          looksLikeBan(text)
        ) {
          await stopAllMinecraftReconnects(
            `[${serverName}] ${text}`
          );

          return;
        }

        if (
          looksLikeOtherClient(text)
        ) {
          state.anotherClientDetected =
            true;

          state.shouldReconnect =
            false;

          await sendDiscordMessage(
            `⚠️ **${serverName}: аккаунт уже используется другим клиентом.**`
          );

          return;
        }

        await handlePossibleVerification(
          key,
          text
        );
      }
    );

    // ========================================================
    // KICK
    // ========================================================

    bot.on(
      "kicked",
      async reason => {
        const text =
          cleanText(reason);

        console.log(
          `[${serverName}] Kicked: ${text}`
        );

        if (
          looksLikeBan(text)
        ) {
          await stopAllMinecraftReconnects(
            `[${serverName}] ${text}`
          );

          return;
        }

        if (
          looksLikeOtherClient(text)
        ) {
          state.anotherClientDetected =
            true;

          state.shouldReconnect =
            false;

          return;
        }

        await sendDiscordMessage(
          `⚠️ **${serverName} кикнут**\n\`${truncateText(
            text,
            1200
          )}\``
        );
      }
    );

    // ========================================================
    // ERROR
    // ========================================================

    bot.on(
      "error",
      error => {
        console.log(
          `[${serverName}] Error: ${error.message}`
        );
      }
    );

    // ========================================================
    // END
    // ========================================================

    bot.on(
      "end",
      () => {
        console.log(
          `[${serverName}] Соединение закрыто.`
        );

        if (
          state.bot === bot
        ) {
          state.bot = null;
        }

        state.isConnecting =
          false;

        clearAutoLeaveTimer(
          key
        );

        if (
          ipBanDetected ||
          !state.shouldReconnect ||
          state.captchaDetected ||
          state.anotherClientDetected
        ) {
          return;
        }

        scheduleReconnect(
          key
        );
      }
    );

    return true;

  } catch (error) {
    console.log(
      `[${serverName}] Connect error: ${error.message}`
    );

    state.bot = null;

    if (
      !ipBanDetected &&
      state.shouldReconnect
    ) {
      scheduleReconnect(
        key
      );
    }

    return false;

  } finally {
    state.isConnecting =
      false;
  }
}

// ============================================================
// RECONNECT
// ============================================================

function scheduleReconnect(key) {
  const state =
    states[key];

  if (
    ipBanDetected ||
    state.reconnectTimer ||
    !state.shouldReconnect ||
    state.captchaDetected ||
    state.anotherClientDetected
  ) {
    return;
  }

  state.reconnectTimer =
    setTimeout(
      async () => {
        state.reconnectTimer =
          null;

        if (
          ipBanDetected ||
          !state.shouldReconnect
        ) {
          return;
        }

        await connectServer(
          key
        );
      },
      RECONNECT_DELAY
    );
}

// ============================================================
// MANUAL RECONNECT
// ============================================================

async function reconnectServer(key) {
  if (ipBanDetected) {
    return false;
  }

  const state =
    states[key];

  state.shouldReconnect =
    true;

  state.captchaDetected =
    false;

  state.anotherClientDetected =
    false;

  if (
    state.reconnectTimer
  ) {
    clearTimeout(
      state.reconnectTimer
    );

    state.reconnectTimer =
      null;
  }

  if (state.bot) {
    try {
      state.bot.quit(
        "Manual reconnect"
      );
    } catch {
      // ignore
    }

    state.bot = null;
  }

  await sleep(1500);

  if (ipBanDetected) {
    return false;
  }

  return await connectServer(
    key
  );
}

// ============================================================
// TAB: ПОЛУЧЕНИЕ ИГРОКОВ
// ============================================================

function getPlayersFromBot(bot) {
  if (
    !bot ||
    !bot.player ||
    !bot.players
  ) {
    return [];
  }

  return Object.values(
    bot.players
  )
    .filter(
      player =>
        player &&
        player.username
    )
    .filter(
      player =>
        player.username !==
        bot.username
    );
}

// ============================================================
// ЦВЕТ PING
// ============================================================

function getPingColor(ping) {
  const value =
    Number(ping);

  if (!Number.isFinite(value)) {
    return "#55ff55";
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
// ЭКРАНИРОВАНИЕ SVG
// ============================================================

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ============================================================
// ПОЛУЧЕНИЕ ИМЕНИ
// ============================================================

function getPlayerName(player) {
  return cleanText(
    player.username
  );
}

// ============================================================
// SVG TEXT
// ============================================================

function svgText(
  x,
  y,
  text,
  color,
  size = 22,
  weight = 400,
  anchor = "start"
) {
  return `
    <text
      x="${x}"
      y="${y}"
      fill="${color}"
      font-family="monospace"
      font-size="${size}px"
      font-weight="${weight}"
      text-anchor="${anchor}"
    >${escapeXml(text)}</text>
  `;
}

// ============================================================
// TAB SVG
// ============================================================

async function generateTabImage(
  key
) {
  const state =
    states[key];

  if (
    !state.bot ||
    !state.bot.player
  ) {
    return null;
  }

  const bot =
    state.bot;

  const isMineBlaze =
    key === "mineblaze";

  const serverName =
    isMineBlaze
      ? "MINEBLAZE"
      : "DEXLAND";

  const modeName =
    isMineBlaze
      ? "KitPvP 2"
      : "KitPvP 1";

  const host =
    isMineBlaze
      ? MINECRAFT_HOST
      : DEXLAND_HOST;

  const players =
    getPlayersFromBot(
      bot
    );

  const online =
    players.length + 1;

  const {
    friends,
    enemies
  } = await getTrackedSets();

  const friendPlayers = [];
  const enemyPlayers = [];
  const normalPlayers = [];

  for (
    const player of players
  ) {
    const username =
      getPlayerName(
        player
      );

    const lower =
      username.toLowerCase();

    if (
      friends.has(lower)
    ) {
      friendPlayers.push(
        player
      );
    } else if (
      enemies.has(lower)
    ) {
      enemyPlayers.push(
        player
      );
    } else {
      normalPlayers.push(
        player
      );
    }
  }

  /*
   * Сортировка по имени.
   */
  const sortPlayers =
    array =>
      array.sort(
        (a, b) =>
          getPlayerName(a)
            .localeCompare(
              getPlayerName(b)
            )
      );

  sortPlayers(
    friendPlayers
  );

  sortPlayers(
    enemyPlayers
  );

  sortPlayers(
    normalPlayers
  );

  /*
   * Обычные игроки распределяются
   * между двумя центральными колонками.
   */
  const middleLeft = [];
  const middleRight = [];

  normalPlayers.forEach(
    (player, index) => {
      if (
        index % 2 === 0
      ) {
        middleLeft.push(
          player
        );
      } else {
        middleRight.push(
          player
        );
      }
    }
  );

  /*
   * Размер картинки.
   */
  const width = 2048;

  const rowHeight = 39;

  const maxRows =
    Math.max(
      friendPlayers.length,
      middleLeft.length,
      middleRight.length,
      enemyPlayers.length,
      1
    );

  const panelHeight =
    Math.max(
      400,
      130 +
        maxRows *
          rowHeight
    );

  const height =
    panelHeight + 100;

  // ----------------------------------------------------------
  // SVG
  // ----------------------------------------------------------

  let svg = `
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="${width}"
    height="${height}"
    viewBox="0 0 ${width} ${height}"
  >

    <defs>

      <linearGradient
        id="bg"
        x1="0"
        y1="0"
        x2="1"
        y2="1"
      >
        <stop
          offset="0%"
          stop-color="#080b12"
        />

        <stop
          offset="50%"
          stop-color="#11151d"
        />

        <stop
          offset="100%"
          stop-color="#05070b"
        />
      </linearGradient>

      <linearGradient
        id="panel"
        x1="0"
        y1="0"
        x2="0"
        y2="1"
      >
        <stop
          offset="0%"
          stop-color="#10141c"
          stop-opacity="0.92"
        />

        <stop
          offset="100%"
          stop-color="#080b11"
          stop-opacity="0.96"
        />
      </linearGradient>

      <filter
        id="blur"
        x="-20%"
        y="-20%"
        width="140%"
        height="140%"
      >
        <feGaussianBlur
          stdDeviation="55"
        />
      </filter>

      <filter
        id="glow"
        x="-50%"
        y="-50%"
        width="200%"
        height="200%"
      >
        <feGaussianBlur
          stdDeviation="7"
          result="blur"
        />

        <feMerge>
          <feMergeNode
            in="blur"
          />

          <feMergeNode
            in="SourceGraphic"
          />
        </feMerge>
      </filter>

    </defs>

    <!-- BACKGROUND -->

    <rect
      width="100%"
      height="100%"
      fill="url(#bg)"
    />

    <circle
      cx="250"
      cy="${height / 2}"
      r="260"
      fill="#19314d"
      opacity="0.22"
      filter="url(#blur)"
    />

    <circle
      cx="1050"
      cy="150"
      r="240"
      fill="#162e25"
      opacity="0.18"
      filter="url(#blur)"
    />

    <circle
      cx="1800"
      cy="${height - 100}"
      r="300"
      fill="#24304b"
      opacity="0.18"
      filter="url(#blur)"
    />

    <!-- HEADER STATUS -->

    <rect
      x="${width / 2 - 115}"
      y="25"
      width="230"
      height="42"
      rx="21"
      fill="#10141a"
      stroke="#424a58"
      stroke-width="2"
    />

    <circle
      cx="${width / 2 - 77}"
      cy="46"
      r="7"
      fill="#36e889"
      filter="url(#glow)"
    />

    ${svgText(
      width / 2 - 57,
      54,
      "На сервере",
      "#eeeeee",
      20,
      600
    )}

    <!-- TITLE -->

    ${svgText(
      width / 2,
      103,
      `${serverName} — ${modeName}`,
      "#ffffff",
      34,
      800,
      "middle"
    )}

    ${svgText(
      width / 2,
      132,
      `Сервер: ${host} | Игроков онлайн: ${online}`,
      "#c6cbd4",
      18,
      500,
      "middle"
    )}

    <!-- MAIN PANEL -->

    <rect
      x="25"
      y="155"
      width="${width - 50}"
      height="${panelHeight}"
      rx="12"
      fill="url(#panel)"
      stroke="#303847"
      stroke-width="2"
    />

    <!-- COLUMN SEPARATORS -->

    <line
      x1="500"
      y1="180"
      x2="500"
      y2="${155 + panelHeight - 20}"
      stroke="#1c222d"
      stroke-width="2"
    />

    <line
      x1="1024"
      y1="180"
      x2="1024"
      y2="${155 + panelHeight - 20}"
      stroke="#1c222d"
      stroke-width="2"
    />

    <line
      x1="1530"
      y1="180"
      x2="1530"
      y2="${155 + panelHeight - 20}"
      stroke="#1c222d"
      stroke-width="2"
    />
  `;

  // ==========================================================
  // COLUMN FUNCTION
  // ==========================================================

  function renderPlayer(
    player,
    x,
    y,
    nameColor
  ) {
    const username =
      getPlayerName(
        player
      );

    const ping =
      Number.isFinite(
        Number(player.ping)
      )
        ? Math.round(
            Number(player.ping)
          )
        : 0;

    const pingColor =
      getPingColor(
        ping
      );

    svg += svgText(
      x,
      y,
      username,
      nameColor,
      20,
      500
    );

    svg += svgText(
      x + 445,
      y,
      `${ping}ms`,
      pingColor,
      20,
      600,
      "end"
    );
  }

  // ==========================================================
  // FRIENDS
  // ==========================================================

  let y = 195;

  svg += svgText(
    45,
    y,
    `FRIEND (${friendPlayers.length})`,
    "#ff38d1",
    21,
    800
  );

  y += 38;

  for (
    const player of friendPlayers
  ) {
    renderPlayer(
      player,
      45,
      y,
      "#ff35d4"
    );

    y += rowHeight;
  }

  // ==========================================================
  // CENTER LEFT
  // ==========================================================

  y = 195;

  svg += svgText(
    545,
    y,
    `PLAYERS (${normalPlayers.length})`,
    "#e8e8e8",
    21,
    800
  );

  y += 38;

  for (
    const player of middleLeft
  ) {
    renderPlayer(
      player,
      545,
      y,
      "#f1f1f1"
    );

    y += rowHeight;
  }

  // ==========================================================
  // CENTER RIGHT
  // ==========================================================

  y = 195;

  for (
    const player of middleRight
  ) {
    renderPlayer(
      player,
      1055,
      y,
      "#f1f1f1"
    );

    y += rowHeight;
  }

  // ==========================================================
  // ENEMIES
  // ==========================================================

  y = 195;

  svg += svgText(
    1560,
    y,
    `ENEMY (${enemyPlayers.length})`,
    "#ff5555",
    21,
    800
  );

  y += 38;

  for (
    const player of enemyPlayers
  ) {
    renderPlayer(
      player,
      1560,
      y,
      "#ff5555"
    );

    y += rowHeight;
  }

  // ==========================================================
  // CLOSE SVG
  // ==========================================================

  svg += `
  </svg>
  `;

  // ==========================================================
  // PNG
  // ==========================================================

  return await sharp(
    Buffer.from(svg)
  )
    .png()
    .toBuffer();
}

// ============================================================
// СОЗДАНИЕ DISCORD ATTACHMENT
// ============================================================

function makeTabAttachment(
  buffer,
  filename
) {
  return new AttachmentBuilder(
    buffer,
    {
      name: filename
    }
  );
}

// ============================================================
// HELP
// ============================================================

function getHelpText() {
  return [
    "🤖 **Minecraft Discord Bot**",
    "",
    "`#help` — помощь",
    "`#tab` — TAB MineBlaze + DexLand",
    "`#kp2` — MineBlaze KitPvP 2",
    "`#reconnect` — переподключить оба сервера",
    "",
    "`#friendadd Nick` — добавить друга",
    "`#friendremove Nick` — удалить друга",
    "`#friends` — друзья",
    "",
    "`#enemyadd Nick` — добавить врага",
    "`#enemyremove Nick` — удалить врага",
    "`#enemies` — враги"
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
          String(
            message.channel.id
          )
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
          .slice(PREFIX.length)
          .toLowerCase();

      const value =
        args
          .slice(1)
          .join(" ")
          .trim();

      // ======================================================
      // HELP
      // ======================================================

      if (
        command === "help"
      ) {
        await message.reply(
          getHelpText()
        );

        return;
      }

      // ======================================================
      // TAB
      // ======================================================

      if (
        command === "tab"
      ) {
        if (
          ipBanDetected
        ) {
          await message.reply(
            "🛑 TAB остановлен: обнаружен IP-бан."
          );

          return;
        }

        await message.reply(
          "⏳ Подключаю серверы и захожу на KitPvP..."
        );

        try {
          // --------------------------------------------------
          // MINEBLAZE
          // --------------------------------------------------

          const mb =
            states.mineblaze;

          if (
            !mb.bot ||
            !mb.bot.player
          ) {
            await connectServer(
              "mineblaze"
            );

            /*
             * connectServer:
             * /login
             * /kp2
             */
            await sleep(
              MODE_WAIT_TIME + 2500
            );

          } else {
            /*
             * Если бот уже подключён,
             * отправляем /kp2 заново.
             */
            await enterKitPvP(
              "mineblaze"
            );
          }

          if (
            ipBanDetected
          ) {
            await message.channel.send(
              "🛑 TAB отменён: обнаружен IP-бан."
            );

            return;
          }

          // --------------------------------------------------
          // DEXLAND
          // --------------------------------------------------

          const dex =
            states.dexland;

          if (
            !dex.bot ||
            !dex.bot.player
          ) {
            await connectServer(
              "dexland"
            );

            /*
             * connectServer:
             * /login
             * /kp1
             */
            await sleep(
              MODE_WAIT_TIME + 2500
            );

          } else {
            await enterKitPvP(
              "dexland"
            );
          }

          if (
            ipBanDetected
          ) {
            await message.channel.send(
              "🛑 TAB отменён: обнаружен IP-бан."
            );

            return;
          }

          // --------------------------------------------------
          // GENERATE IMAGES
          // --------------------------------------------------

          const mineBlazeImage =
            await generateTabImage(
              "mineblaze"
            );

          const dexLandImage =
            await generateTabImage(
              "dexland"
            );

          // --------------------------------------------------
          // MINEBLAZE
          // --------------------------------------------------

          if (
            mineBlazeImage
          ) {
            await message.channel.send({
              files: [
                makeTabAttachment(
                  mineBlazeImage,
                  "mineblaze-tab.png"
                )
              ]
            });
          } else {
            await message.channel.send(
              "❌ MineBlaze: не удалось получить TAB."
            );
          }

          // --------------------------------------------------
          // DEXLAND
          // --------------------------------------------------

          if (
            dexLandImage
          ) {
            await message.channel.send({
              files: [
                makeTabAttachment(
                  dexLandImage,
                  "dexland-tab.png"
                )
              ]
            });
          } else {
            await message.channel.send(
              "❌ DexLand: не удалось получить TAB."
            );
          }

        } catch (error) {
          console.log(
            `[TAB] ${error.stack || error.message}`
          );

          await message.channel.send(
            `❌ Ошибка TAB: \`${error.message}\``
          );
        }

        return;
      }

      // ======================================================
      // KP2
      // ======================================================

      if (
        command === "kp2"
      ) {
        if (
          ipBanDetected
        ) {
          await message.reply(
            "🛑 `/kp2` остановлен: обнаружен IP-бан."
          );

          return;
        }

        try {
          const state =
            states.mineblaze;

          if (
            state.bot &&
            state.bot.player
          ) {
            await enterKitPvP(
              "mineblaze"
            );

            await message.reply(
              "🎮 Отправлен `/kp2`."
            );

          } else {
            await message.reply(
              "⏳ Подключаю MineBlaze..."
            );

            await connectServer(
              "mineblaze"
            );

            await sleep(
              MODE_WAIT_TIME + 2000
            );

            if (
              state.bot &&
              state.bot.player &&
              !ipBanDetected
            ) {
              await message.channel.send(
                "🎮 MineBlaze подключён, `/kp2` отправлен."
              );
            }
          }

        } catch (error) {
          await message.channel.send(
            `❌ Ошибка: \`${error.message}\``
          );
        }

        return;
      }

      // ======================================================
      // RECONNECT
      // ======================================================

      if (
        command === "reconnect"
      ) {
        if (
          ipBanDetected
        ) {
          await message.reply(
            "🛑 Reconnect остановлен: обнаружен IP-бан."
          );

          return;
        }

        await message.reply(
          "🔄 Переподключаю оба сервера..."
        );

        try {
          await reconnectServer(
            "mineblaze"
          );

          if (
            ipBanDetected
          ) {
            return;
          }

          await sleep(1000);

          await reconnectServer(
            "dexland"
          );

          if (
            !ipBanDetected
          ) {
            await message.channel.send(
              "✅ Оба сервера переподключены."
            );
          }

        } catch (error) {
          await message.channel.send(
            `❌ Ошибка reconnect: \`${error.message}\``
          );
        }

        return;
      }

      // ======================================================
      // FRIEND ADD
      // ======================================================

      if (
        command === "friendadd"
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
          `🟢 **${value}** добавлен в Friends.`
        );

        return;
      }

      // ======================================================
      // FRIEND REMOVE
      // ======================================================

      if (
        command === "friendremove"
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
          `🗑️ **${value}** удалён.`
        );

        return;
      }

      // ======================================================
      // FRIENDS
      // ======================================================

      if (
        command === "friends"
      ) {
        const friends =
          await getTrackedPlayers(
            "friend"
          );

        if (
          !friends.length
        ) {
          await message.reply(
            "🟢 Friends пуст."
          );

          return;
        }

        await message.reply(
          `🟢 **Friends (${friends.length})**\n\n` +
          friends
            .map(
              x => `• ${x}`
            )
            .join("\n")
        );

        return;
      }

      // ======================================================
      // ENEMY ADD
      // ======================================================

      if (
        command === "enemyadd"
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
          `🔴 **${value}** добавлен в Enemies.`
        );

        return;
      }

      // ======================================================
      // ENEMY REMOVE
      // ======================================================

      if (
        command === "enemyremove"
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
          `🗑️ **${value}** удалён из Enemies.`
        );

        return;
      }

      // ======================================================
      // ENEMIES
      // ======================================================

      if (
        command === "enemies"
      ) {
        const enemies =
          await getTrackedPlayers(
            "enemy"
          );

        if (
          !enemies.length
        ) {
          await message.reply(
            "🔴 Enemies пуст."
          );

          return;
        }

        await message.reply(
          `🔴 **Enemies (${enemies.length})**\n\n` +
          enemies
            .map(
              x => `• ${x}`
            )
            .join("\n")
        );

        return;
      }

    } catch (error) {
      console.log(
        `[Discord] Command error: ${
          error.stack ||
          error.message
        }`
      );
    }
  }
);

// ============================================================
// DISCORD READY
// ============================================================

discord.once(
  "ready",
  async () => {
    console.log(
      `🤖 Discord подключён как ${discord.user.tag}`
    );

    console.log(
      "🟢 Бот готов. Minecraft подключается по командам."
    );
  }
);

// ============================================================
// DISCORD ERROR
// ============================================================

discord.on(
  "error",
  error => {
    console.log(
      `[Discord] Error: ${error.message}`
    );
  }
);

// ============================================================
// START
// ============================================================

async function start() {
  try {
    await initDatabase();

    await discord.login(
      DISCORD_TOKEN
    );

  } catch (error) {
    console.error(
      "❌ Ошибка запуска:",
      error
    );

    process.exit(1);
  }
}

// ============================================================
// SHUTDOWN
// ============================================================

async function shutdown() {
  console.log(
    "🛑 Завершение работы..."
  );

  for (
    const key of [
      "mineblaze",
      "dexland"
    ]
  ) {
    const state =
      states[key];

    state.shouldReconnect =
      false;

    if (
      state.reconnectTimer
    ) {
      clearTimeout(
        state.reconnectTimer
      );

      state.reconnectTimer =
        null;
    }

    clearAutoLeaveTimer(
      key
    );

    if (state.bot) {
      try {
        state.bot.quit(
          "Shutdown"
        );
      } catch {
        // ignore
      }
    }
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

process.on(
  "SIGINT",
  shutdown
);

process.on(
  "SIGTERM",
  shutdown
);

// ============================================================
// START
// ============================================================

start();
