const mineflayer = require('mineflayer');
const Discord = require('discord.js');
require('dotenv').config();

// ==================== КОНФИГУРАЦИЯ ====================
const config = {
    serverIP: process.env.SERVER_IP || 'play.mineblaze.com',
    serverPort: parseInt(process.env.SERVER_PORT) || 25565,
    botName: process.env.BOT_NAME || `TabBot_${Math.floor(Math.random() * 1000)}`,
    botVersion: process.env.BOT_VERSION || '1.20.4',
    discordToken: process.env.DISCORD_TOKEN,
    discordChannelId: process.env.CHANNEL_ID,
    updateInterval: 30000,
};

// ==================== ОЧИСТКА ТЕКСТА MINECRAFT ====================
function cleanMinecraftText(text) {
    if (!text) return '';
    // Удаляем цветовые коды (§a, §b, §l и т.д.)
    return text.replace(/§[0-9a-fklmnor]/g, '').trim();
}

// ==================== ПАРСИНГ ТАБА (КАК НА СКРИНЕ) ====================
function parseTabList(bot) {
    try {
        if (!bot || !bot.players) return '❌ Бот не подключен';

        // Сортируем игроков по пингу (как на скрине)
        const players = Object.values(bot.players)
            .filter(p => p.username !== bot.username)
            .sort((a, b) => (a.ping || 999) - (b.ping || 999));

        let tabText = '';

        players.forEach(player => {
            // Получаем отображаемое имя (содержит ранг, клан, уровень)
            let displayName = player.displayName ? player.displayName.toString() : player.username;
            displayName = cleanMinecraftText(displayName);

            // Пинг
            const ping = player.ping || '?';
            
            // Формат: Ранг | Ник [Клан] [Уровень] Пинг ms
            // Если displayName уже содержит пинг, убираем его, чтобы не дублировать
            let line = `${displayName} ${ping} ms`;
            
            tabText += line + '\n';
        });

        // Футер со скрина
        tabText += '\nStaff in Vanish: 1';

        return tabText || 'На сервере никого нет';
    } catch (error) {
        console.error('Ошибка парсинга:', error);
        return '❌ Ошибка получения данных';
    }
}

// ==================== ОТПРАВКА В DISCORD ====================
async function sendTabToDiscord(client, tabData) {
    try {
        const channel = client.channels.cache.get(config.discordChannelId);
        if (!channel) return;

        const embed = new Discord.EmbedBuilder()
            .setTitle('📊 Таб игроков MineBlaze (KitPvP 2)')
            .setDescription(`\`\`\`\n${tabData}\n\`\`\``)
            .setColor(0x2b2d31) // Тёмный цвет как в Discord
            .setFooter({ text: `Обновлено: ${new Date().toLocaleTimeString('ru-RU')}` })
            .setTimestamp();

        await channel.send({ embeds: [embed] });
        console.log('✅ Таб отправлен!');
    } catch (error) {
        console.error('❌ Ошибка Discord:', error);
    }
}

// ==================== ЗАПУСК ====================
const discordClient = new Discord.Client({
    intents: [Discord.GatewayIntentBits.Guilds, Discord.GatewayIntentBits.GuildMessages]
});

discordClient.once('ready', () => {
    console.log(`✅ Discord бот ${discordClient.user.tag} запущен!`);

    const bot = mineflayer.createBot({
        host: config.serverIP,
        port: config.serverPort,
        username: config.botName,
        version: config.botVersion,
        auth: 'offline'
    });

    bot.on('login', () => {
        console.log(`✅ Бот ${config.botName} зашёл на сервер!`);
        
        // Ждём загрузки и отправляем таб
        setTimeout(() => {
            const tabData = parseTabList(bot);
            sendTabToDiscord(discordClient, tabData);
        }, 5000);

        // Обновление каждые 30 секунд
        setInterval(() => {
            if (bot && bot.connected) {
                const tabData = parseTabList(bot);
                sendTabToDiscord(discordClient, tabData);
            }
        }, config.updateInterval);
    });

    bot.on('error', (err) => console.error('❌ Ошибка бота:', err));
    bot.on('end', () => console.log('🔄 Бот отключился, перезапуск...'));
});

discordClient.login(config.discordToken);
