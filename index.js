const mineflayer = require('mineflayer');

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    Events
} = require('discord.js');

// =========================
// НАСТРОЙКИ ИЗ RENDER
// =========================

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;

const MINECRAFT_HOST = process.env.MINECRAFT_HOST || 'mc.mineblaze.net';
const MINECRAFT_PORT = Number(process.env.MINECRAFT_PORT) || 25565;
const MINECRAFT_USERNAME = process.env.MINECRAFT_USERNAME;
const MINECRAFT_VERSION = process.env.MINECRAFT_VERSION || undefined;

const SERVER_PASSWORD = process.env.SERVER_PASSWORD;

// Команда для перехода в KitPvP 2
const KITPVP2_COMMAND =
    process.env.KITPVP2_COMMAND || '/server kitpvp2';


// =========================
// ПРОВЕРКА НАСТРОЕК
// =========================

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


// =========================
// DISCORD
// =========================

const discord = new Client({
    intents: [
        GatewayIntentBits.Guilds
    ]
});


// =========================
// MINECRAFT
// =========================

let mcBot = null;
let reconnectTimer = null;
let isConnecting = false;


// =========================
// СОЗДАНИЕ MINECRAFT БОТА
// =========================

function connectMinecraft() {

    if (isConnecting) {
        return;
    }

    if (mcBot) {
        try {
            mcBot.quit();
        } catch (e) {}
    }

    isConnecting = true;

    console.log('[MC] Подключение к MineBlaze...');
    console.log(`[MC] Сервер: ${MINECRAFT_HOST}:${MINECRAFT_PORT}`);
    console.log(`[MC] Ник: ${MINECRAFT_USERNAME}`);

    const options = {
        host: MINECRAFT_HOST,
        port: MINECRAFT_PORT,
        username: MINECRAFT_USERNAME,
        auth: 'offline'
    };

    if (MINECRAFT_VERSION) {
        options.version = MINECRAFT_VERSION;
    }

    mcBot = mineflayer.createBot(options);


    // =========================
    // ПОДКЛЮЧЕНИЕ
    // =========================

    mcBot.once('spawn', () => {

        isConnecting = false;

        console.log('[MC] Бот успешно подключился к MineBlaze!');

        // Если сервер требует /login
        if (SERVER_PASSWORD) {

            setTimeout(() => {

                console.log('[MC] Выполняю авторизацию...');

                mcBot.chat(`/login ${SERVER_PASSWORD}`);

            }, 3000);
        }
    });


    // =========================
    // СООБЩЕНИЯ MINECRAFT
    // =========================

    mcBot.on('messagestr', (message) => {

        console.log(`[MC] ${message}`);

    });


    // =========================
    // KICK
    // =========================

    mcBot.on('kicked', (reason) => {

        console.log('[MC] Бот был кикнут:');
        console.log(reason);

        scheduleReconnect();

    });


    // =========================
    // ОШИБКА
    // =========================

    mcBot.on('error', (error) => {

        console.error('[MC] Ошибка:', error.message);

    });


    // =========================
    // ОТКЛЮЧЕНИЕ
    // =========================

    mcBot.on('end', () => {

        console.log('[MC] Соединение с MineBlaze закрыто.');

        isConnecting = false;

        scheduleReconnect();

    });
}


// =========================
// ПЕРЕПОДКЛЮЧЕНИЕ
// =========================

function scheduleReconnect() {

    if (reconnectTimer) {
        return;
    }

    console.log('[MC] Переподключение через 10 секунд...');

    reconnectTimer = setTimeout(() => {

        reconnectTimer = null;

        connectMinecraft();

    }, 10000);
}


// =========================
// DISCORD READY
// =========================

discord.once(Events.ClientReady, async (client) => {

    console.log(`[DISCORD] Авторизован как ${client.user.tag}`);
    console.log('[DISCORD] Бот готов принимать команды!');

    // =========================
    // РЕГИСТРАЦИЯ /KP2
    // =========================

    const commands = [

        new SlashCommandBuilder()
            .setName('kp2')
            .setDescription('Перейти на KitPvP 2')
            .toJSON()

    ];

    const rest = new REST({ version: '10' })
        .setToken(DISCORD_TOKEN);

    try {

        console.log('[DISCORD] Регистрирую команду /kp2...');

        await rest.put(
            Routes.applicationCommands(DISCORD_CLIENT_ID),
            {
                body: commands
            }
        );

        console.log('[DISCORD] Команда /kp2 зарегистрирована!');

    } catch (error) {

        console.error(
            '[DISCORD] Ошибка регистрации команды:',
            error
        );
    }
});


// =========================
// DISCORD COMMANDS
// =========================

discord.on(Events.InteractionCreate, async (interaction) => {

    if (!interaction.isChatInputCommand()) {
        return;
    }

    // Нам нужна только /kp2
    if (interaction.commandName !== 'kp2') {
        return;
    }


    // Проверяем канал
    if (interaction.channelId !== CHANNEL_ID) {

        await interaction.reply({
            content: '❌ Эту команду нельзя использовать в этом канале.',
            ephemeral: true
        });

        return;
    }


    // Проверяем Minecraft
    if (!mcBot) {

        await interaction.reply({
            content: '❌ Minecraft-бот сейчас не подключён.',
            ephemeral: true
        });

        return;
    }


    if (!mcBot.player) {

        await interaction.reply({
            content: '⏳ Minecraft-бот ещё подключается к серверу.',
            ephemeral: true
        });

        return;
    }


    // Отвечаем Discord
    await interaction.reply({
        content: '🔄 Перехожу на KitPvP 2...'
    });


    // Отправляем команду Minecraft
    console.log(
        `[MC] Отправляю команду: ${KITPVP2_COMMAND}`
    );

    mcBot.chat(KITPVP2_COMMAND);

});


// =========================
// ЗАПУСК
// =========================

console.log('[DISCORD] Подключение к Discord...');

discord.login(DISCORD_TOKEN);

connectMinecraft();
