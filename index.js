const mineflayer = require('mineflayer');

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    Events
} = require('discord.js');


// ========================================
// НАСТРОЙКИ RENDER
// ========================================

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;

const MINECRAFT_HOST =
    process.env.MINECRAFT_HOST || 'mc.mineblaze.net';

const MINECRAFT_PORT =
    Number(process.env.MINECRAFT_PORT) || 25565;

const MINECRAFT_USERNAME =
    process.env.MINECRAFT_USERNAME;

const MINECRAFT_VERSION =
    process.env.MINECRAFT_VERSION || undefined;

const SERVER_PASSWORD =
    process.env.SERVER_PASSWORD;


// ========================================
// ПРОВЕРКА НАСТРОЕК
// ========================================

if (!DISCORD_TOKEN) {
    console.error('[ERROR] Не указан DISCORD_TOKEN');
    process.exit(1);
}

if (!DISCORD_CLIENT_ID) {
    console.error('[ERROR] Не указан DISCORD_CLIENT_ID');
    process.exit(1);
}

if (!CHANNEL_ID) {
    console.error('[ERROR] Не указан CHANNEL_ID');
    process.exit(1);
}

if (!MINECRAFT_USERNAME) {
    console.error('[ERROR] Не указан MINECRAFT_USERNAME');
    process.exit(1);
}


// ========================================
// DISCORD
// ========================================

const discord = new Client({
    intents: [
        GatewayIntentBits.Guilds
    ]
});


// ========================================
// MINECRAFT
// ========================================

let mcBot = null;
let reconnectTimer = null;
let isConnecting = false;


// ========================================
// ПОДКЛЮЧЕНИЕ К MINECRAFT
// ========================================

function connectMinecraft() {

    if (isConnecting) {
        return;
    }

    isConnecting = true;

    console.log('[MC] Подключение к MineBlaze...');
    console.log(
        `[MC] Сервер: ${MINECRAFT_HOST}:${MINECRAFT_PORT}`
    );
    console.log(
        `[MC] Ник: ${MINECRAFT_USERNAME}`
    );

    const options = {
        host: MINECRAFT_HOST,
        port: MINECRAFT_PORT,
        username: MINECRAFT_USERNAME,
        auth: 'offline'
    };

    if (MINECRAFT_VERSION) {
        options.version = MINECRAFT_VERSION;
    }

    try {

        mcBot = mineflayer.createBot(options);

    } catch (error) {

        console.error(
            '[MC] Ошибка создания бота:',
            error
        );

        isConnecting = false;
        scheduleReconnect();

        return;
    }


    // ====================================
    // SPAWN
    // ====================================

    mcBot.once('spawn', () => {

        isConnecting = false;

        console.log(
            '[MC] Бот успешно подключился к MineBlaze!'
        );

        // Авторизация
        if (SERVER_PASSWORD) {

            setTimeout(() => {

                if (!mcBot) {
                    return;
                }

                console.log(
                    '[MC] Выполняю авторизацию...'
                );

                mcBot.chat(
                    `/login ${SERVER_PASSWORD}`
                );

            }, 3000);
        }
    });


    // ====================================
    // СООБЩЕНИЯ MINECRAFT
    // ====================================

    mcBot.on('messagestr', (message) => {

        console.log(`[MC] ${message}`);

    });


    // ====================================
    // KICK
    // ====================================

    mcBot.on('kicked', (reason) => {

        console.log('[MC] Бот был кикнут:');
        console.log(reason);

    });


    // ====================================
    // ОШИБКА
    // ====================================

    mcBot.on('error', (error) => {

        console.error(
            '[MC] Ошибка:',
            error.message
        );

    });


    // ====================================
    // ОТКЛЮЧЕНИЕ
    // ====================================

    mcBot.on('end', () => {

        console.log(
            '[MC] Соединение с MineBlaze закрыто.'
        );

        isConnecting = false;

        scheduleReconnect();

    });
}


// ========================================
// АВТОПЕРЕПОДКЛЮЧЕНИЕ
// ========================================

function scheduleReconnect() {

    if (reconnectTimer) {
        return;
    }

    console.log(
        '[MC] Переподключение через 10 секунд...'
    );

    reconnectTimer = setTimeout(() => {

        reconnectTimer = null;

        connectMinecraft();

    }, 10000);
}


// ========================================
// ПОЛУЧЕНИЕ TAB
// ========================================

function getTabList() {

    if (!mcBot || !mcBot.players) {
        return [];
    }

    return Object.values(mcBot.players)
        .map(player => {

            return {
                name: player.username,
                ping: player.ping
            };

        })
        .sort((a, b) =>
            a.name.localeCompare(b.name)
        );
}


// ========================================
// DISCORD READY
// ========================================

discord.once(Events.ClientReady, async (client) => {

    console.log(
        `[DISCORD] Авторизован как ${client.user.tag}`
    );

    console.log(
        '[DISCORD] Бот готов принимать команды!'
    );


    // ====================================
    // РЕГИСТРАЦИЯ SLASH-КОМАНД
    // ====================================

    const commands = [

        new SlashCommandBuilder()
            .setName('kp2')
            .setDescription('Перейти на KitPvP 2')
            .toJSON(),

        new SlashCommandBuilder()
            .setName('tab')
            .setDescription('Показать игроков из TAB Minecraft')
            .toJSON()

    ];


    const rest = new REST({
        version: '10'
    }).setToken(DISCORD_TOKEN);


    try {

        console.log(
            '[DISCORD] Регистрирую команды...'
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
            '[DISCORD] Команды /kp2 и /tab зарегистрированы!'
        );

    } catch (error) {

        console.error(
            '[DISCORD] Ошибка регистрации команд:',
            error
        );
    }
});


// ========================================
// DISCORD INTERACTIONS
// ========================================

discord.on(
    Events.InteractionCreate,
    async (interaction) => {

        if (!interaction.isChatInputCommand()) {
            return;
        }


        // ====================================
        // ПРОВЕРКА КАНАЛА
        // ====================================

        if (interaction.channelId !== CHANNEL_ID) {

            await interaction.reply({
                content:
                    '❌ Эту команду нельзя использовать в этом канале.',
                ephemeral: true
            });

            return;
        }


        // ====================================
        // /KP2
        // ====================================

        if (interaction.commandName === 'kp2') {

            if (!mcBot || !mcBot.player) {

                await interaction.reply({
                    content:
                        '❌ Minecraft-бот сейчас не подключён.',
                    ephemeral: true
                });

                return;
            }


            console.log(
                '[MC] Discord запросил переход на KitPvP 2'
            );

            // ВАЖНО:
            // Это команда MineBlaze,
            // а не Discord-команда.
            mcBot.chat('/kp2');


            await interaction.reply({
                content:
                    '⚔️ Бот отправил `/kp2` и переходит на KitPvP 2!'
            });

            return;
        }


        // ====================================
        // /TAB
        // ====================================

        if (interaction.commandName === 'tab') {

            if (!mcBot || !mcBot.player) {

                await interaction.reply({
                    content:
                        '❌ Minecraft-бот сейчас не подключён.',
                    ephemeral: true
                });

                return;
            }


            // Получаем уже имеющийся список
            // от Mineflayer.
            //
            // НИКАКОЙ /tab В MINECRAFT
            // ЗДЕСЬ НЕ ОТПРАВЛЯЕТСЯ.

            const players = getTabList();


            if (players.length === 0) {

                await interaction.reply({
                    content:
                        '❌ Список TAB пока пустой.',
                    ephemeral: true
                });

                return;
            }


            // Discord ограничивает длину сообщения.
            // Показываем максимум 50 игроков.
            const shownPlayers =
                players.slice(0, 50);


            let text =
                '## 🟢 MineBlaze TAB\n' +
                `**Игроков:** ${players.length}\n\n`;


            for (const player of shownPlayers) {

                let ping = '?';

                if (typeof player.ping === 'number') {
                    ping = `${player.ping} ms`;
                }

                text +=
                    `\`${player.name}\` — ${ping}\n`;
            }


            if (players.length > 50) {

                text +=
                    `\n...и ещё ${players.length - 50} игроков.`;
            }


            await interaction.reply({
                content: text
            });


            console.log(
                `[DISCORD] Отправлен TAB: ${players.length} игроков`
            );

            return;
        }
    }
);


// ========================================
// ЗАПУСК
// ========================================

console.log(
    '[DISCORD] Подключение к Discord...'
);

discord.login(DISCORD_TOKEN);

connectMinecraft();
