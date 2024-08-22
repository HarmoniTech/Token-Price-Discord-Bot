const dotenv = require("dotenv");
const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');
const path = require('path');

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const channelId = process.env.PRICE_CHANNEL;

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    postTokenPrice();
    setInterval(postTokenPrice, 3600000); // Every hour
    postNewDayMessage();
    setInterval(postNewDayMessage, 24 * 3600000); // Every day
});

async function getTokenPrice() {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${process.env.TOKEN_ADDRESS}`); // Replace with the actual API URL
        console.log(response);
        // Find the pair with dexId "raydium"
        const raydiumPair = response.data.pairs.find(pair => pair.dexId === "raydium");
        console.log(raydiumPair.priceUsd);
        return raydiumPair.priceUsd;
    } catch (error) {
        console.error("Error fetching token price:", error);
        return null;
    }
}

async function postTokenPrice() {
    const channel = client.channels.cache.get(channelId);
    if (!channel) return console.error("Channel not found");

    const price = await getTokenPrice();
    if (!price) return;

    const embed = {
        color: 0x0099ff,
        title: '**Price**',
        description: `${price}`,
        thumbnail: {
            url: `attachment://token-avatar.png`
        }
    };

    await channel.send({ 
        embeds: [embed],
        files: [{ attachment: path.join(__dirname, 'assets', 'token-avatar.png'), name: 'token-avatar.png' }]
    });
}

async function postNewDayMessage() {
    const now = new Date();
    const utcHour = now.getUTCHours();

    if (utcHour === 0) { // Checks if it's the start of a new UTC day
        const channel = client.channels.cache.get(channelId);
        if (channel) {
            await channel.send("It's a new day!");
        }
    }
}

client.login(process.env.DISCORD_TOKEN);
