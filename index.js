const mineflayer = require('mineflayer');
const {
    Client,
    GatewayIntentBits
} = require('discord.js');

// ======================================================
// НАСТРОЙКИ MINECRAFT
// ======================================================

const minecraftConfig = {
    host: 'mc.mineblaze.net',
    port: 25565,

    // Ник Minecraft-аккаунта бота
    username: 'YOUR_MINECRAFT_NICK',

    version: false
};

// ======================================================
// DISCORD
// ======================================================

const discordToken = process.env.DISCORD_TOKEN;

// Проверяем, существует ли переменная в Render
console.log(
    '[DISCORD] Token найден:',
    Boolean(discordToken)
);

if (!discordToken) {
    console.error(
        '[DISCORD] ОШИБКА: переменная DISCORD_TOKEN не найдена!'
    );

    process.exit(1);
}

// ======================================================
// MINECRAFT BOT
// ======================================================

let mcBot = null;
let reconnectTimer = null;

function createMinecraftBot() {
    console.log('[MC] Подключение к MineBlaze...');

    try {
        mcBot = mineflayer.createBot(minecraftConfig);
    } catch (error) {
        console.error(
            '[MC] Ошибка создания бота:',
            error.message
        );

        scheduleReconnect();
        return;
    }

    mcBot.once('login', () => {
        console.log('[MC] Minecraft login OK');
    });

    mcBot.once('spawn', () => {
        console.log('[MC] Бот вошёл на сервер MineBlaze');
        console.log(`[MC] Ник: ${mcBot.username}`);
    });

    mcBot.on('error', error => {
        console.error(
            '[MC] ERROR:',
            error.message
        );
    });

    mcBot.on('kicked', reason => {
        console.log(
            '[MC] Бот был кикнут:',
            reason
        );
    });

    mcBot.on('end', () => {
        console.log(
            '[MC] Соединение с MineBlaze закрыто'
        );

        scheduleReconnect();
    });
}

function scheduleReconnect() {
    if (reconnectTimer) return;

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;

        console.log(
            '[MC] Повторное подключение...'
        );

        createMinecraftBot();
    }, 10000);
}

createMinecraftBot();

// ======================================================
// УБИРАЕМ MINECRAFT COLOR CODES
// ======================================================

function stripMinecraftColors(text) {
    if (!text) return '';

    return String(text)
        .replace(/§[0-9a-fk-or]/gi, '')
        .replace(/&[0-9a-fk-or]/gi, '')
        .trim();
}

// ======================================================
// ПОЛУЧАЕМ PREFIX / RANK
// ======================================================

function getPlayerPrefix(username) {
    if (!mcBot) return '';

    // Способ №1 — teamMap
    const teamName = mcBot.teamMap?.[username];

    if (teamName) {
        const team = mcBot.teams?.[teamName];

        if (team?.prefix) {
            return stripMinecraftColors(
                team.prefix.toString()
            );
        }
    }

    // Способ №2 — ищем игрока во всех командах
    const teams = Object.values(
        mcBot.teams || {}
    );

    for (const team of teams) {
        if (!team.members) continue;

        if (team.members.includes(username)) {
            if (team.prefix) {
                return stripMinecraftColors(
                    team.prefix.toString()
                );
            }
        }
    }

    return '';
}

// ======================================================
// ПОЛУЧАЕМ СПИСОК ИГРОКОВ
// ======================================================

function getTabPlayers() {
    if (!mcBot) return [];

    const players = Object.values(
        mcBot.players || {}
    );

    return players
        .map(player => {
            const username =
                player.username || 'Unknown';

            const ping =
                typeof player.ping === 'number'
                    ? player.ping
                    : null;

            const prefix =
                getPlayerPrefix(username);

            let displayName = username;

            if (player.displayName) {
                displayName =
                    stripMinecraftColors(
                        player.displayName.toString()
                    );
            }

            return {
                username,
                ping,
                prefix,
                displayName
            };
        })
        .sort((a, b) =>
            a.username.localeCompare(
                b.username,
                'en',
                {
                    sensitivity: 'base'
                }
            )
        );
}

// ======================================================
// СОЗДАЁМ TAB
// ======================================================

function createTabText(players) {
    let result = '';

    result += 'Minecraft TAB\n';
    result += `Игроков: ${players.length}\n`;
    result += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

    for (const player of players) {
        let line = '';

        // Ранг / prefix
        if (
            player.prefix &&
            player.prefix !== player.username
        ) {
            line += `${player.prefix} `;
        }

        // Ник
        line += player.username;

        // Ping
        if (player.ping !== null) {
            line += `  ${player.ping} ms`;
        } else {
            line += '  ? ms';
        }

        result += line + '\n';
    }

    result +=
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

    return result;
}

// ======================================================
// DISCORD CLIENT
// ======================================================

const discord = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ======================================================
// DISCORD READY
// ======================================================

discord.once('ready', () => {
    console.log(
        `[DISCORD] Авторизован как ${discord.user.tag}`
    );

    console.log(
        '[DISCORD] Бот готов принимать команды!'
    );
});

// ======================================================
// DISCORD COMMANDS
// ======================================================

discord.on('messageCreate', async message => {
    try {
        // Игнорируем сообщения самого бота
        if (message.author.bot) return;

        const command =
            message.content
                .trim()
                .toLowerCase();

        // ==================================================
        // !TAB
        // ==================================================

        if (command === '!tab') {
            if (!mcBot) {
                await message.reply(
                    '❌ Minecraft-бот сейчас не подключён.'
                );

                return;
            }

            const players =
                getTabPlayers();

            if (!players.length) {
                await message.reply(
                    '❌ Mineflayer пока не получил список игроков.'
                );

                return;
            }

            const tab =
                createTabText(players);

            const lines =
                tab.split('\n');

            let chunk =
                '```text\n';

            for (const line of lines) {
                if (
                    (chunk + line + '\n')
                        .length >= 1900
                ) {
                    chunk += '```';

                    await message.channel.send(
                        chunk
                    );

                    chunk = '```text\n';
                }

                chunk += line + '\n';
            }

            if (chunk !== '```text\n') {
                chunk += '```';

                await message.channel.send(
                    chunk
                );
            }

            return;
        }

        // ==================================================
        // !TABDEBUG
        // ==================================================

        if (command === '!tabdebug') {
            if (!mcBot) {
                await message.reply(
                    '❌ Minecraft-бот не подключён.'
                );

                return;
            }

            const players =
                getTabPlayers();

            let debug =
                '```text\n';

            debug +=
                `Players: ${players.length}\n`;

            debug +=
                `Teams: ${
                    Object.keys(
                        mcBot.teams || {}
                    ).length
                }\n\n`;

            // Игроки
            debug +=
                'PLAYERS:\n';

            for (const player of players) {
                debug +=
                    `${player.username} | ` +
                    `prefix="${player.prefix}" | ` +
                    `ping=${player.ping}\n`;
            }

            debug += '\nTEAMS:\n';

            // Teams
            for (
                const team of Object.values(
                    mcBot.teams || {}
                )
            ) {
                debug +=
                    `TEAM: ${team.name}\n`;

                debug +=
                    `PREFIX: ${
                        team.prefix
                            ? team.prefix.toString()
                            : ''
                    }\n`;

                debug +=
                    `SUFFIX: ${
                        team.suffix
                            ? team.suffix.toString()
                            : ''
                    }\n`;

                debug +=
                    `MEMBERS: ${
                        team.members
                            ?.join(', ') || ''
                    }\n\n`;
            }

            debug += '```';

            // Discord ограничивает сообщения
            if (debug.length > 1900) {
                debug =
                    debug.slice(0, 1850) +
                    '\n...```';
            }

            await message.reply(debug);

            return;
        }

    } catch (error) {
        console.error(
            '[DISCORD] Ошибка команды:',
            error
        );

        try {
            await message.reply(
                '❌ Произошла ошибка при выполнении команды.'
            );
        } catch {}
    }
});

// ======================================================
// DISCORD LOGIN
// ======================================================

discord.login(discordToken)
    .then(() => {
        console.log(
            '[DISCORD] Подключение к Discord выполнено.'
        );
    })
    .catch(error => {
        console.error(
            '[DISCORD] Ошибка авторизации:',
            error.message
        );

        process.exit(1);
    });
