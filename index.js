const dotenv = require("dotenv");
const { Client, GatewayIntentBits, userMention, roleMention, TextInputStyle } = require('discord.js');
const PoolModel = require('./models/PoolModel/poolModel');
const UserModel = require('./models/UserModel/userModel');
const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');
const schedule = require('node-schedule')
const { Connection, PublicKey } = require('@solana/web3.js');
const { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddress, getMint, getAccount, getOrCreateAssociatedTokenAccount } = require('@solana/spl-token');

dotenv.config();

const SUPPLY = 420000069;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const channelId = process.env.PRICE_CHANNEL;

// Initialize Solana connection and wallet
const SOLANA_NETWORK = process.env.RPC; // Mainnet endpoint
const connection = new Connection(SOLANA_NETWORK);

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    updateBotTitleAndStatus();

    schedule.scheduleJob('0 * * * *', () => {
        const now = new Date();
        if (now.getUTCHours() === 0) {
            updateBotTitleAndStatus();
            postNewDayMessage();
            postBigPriceChanged();
            searchPool();
        } else {
            updateBotTitleAndStatus();
        }
    })

    schedule.scheduleJob('30 * * * *', () => {
        postTokenPrice();
    })
});

async function getTokenHolders() {
    const url = process.env.RPC;
    let page = 1;
    let ownerCount = 0;

    while (true) {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                method: "getTokenAccounts",
                id: "helius-test",
                params: {
                    page: page,
                    limit: 1000,
                    displayOptions: {},
                    mint: "AmgUMQeqW8H74trc8UkKjzZWtxBdpS496wh4GLy2mCpo",
                },
            }),
        });
        const data = await response.json();

        if (!data.result || data.result.token_accounts.length === 0) {
            console.log(`No more results. Total pages: ${page - 1}`);

            break;
        }
        console.log(`Processing results from page ${page}`);
        data.result.token_accounts.forEach((account) => {
            // if (account.amount > 9) {
            ownerCount++;
            // }
        });
        page++;
    }
    return ownerCount;
}

async function updateBotTitleAndStatus() {
    try {
        const price = await getTokenPrice();
        const supply = await getTokenSupply();
        if (!price || !supply) return;

        const marketCap = price * supply;

        // Update bot's display name with price
        await client.user.setUsername(`$TOKE=$${price.toFixed(5)}`);

        // Update bot's custom status
        client.user.setActivity(`$${marketCap.toFixed(2).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")} mkt cap`, { type: 4 })

    } catch (error) {
        console.error("Error updating bot title and status:", error);
    }
}

async function getTokenPrice() {
    try {
        let price;
        const options = { method: 'GET', headers: { 'X-API-KEY': process.env.BIRDEYE_KEY } };
        await fetch(`https://public-api.birdeye.so/defi/price?address=${process.env.TOKEN_ADDRESS}`, options)
            .then(response => response.json())
            .then(response => {
                price = response.data.value;
            })
            .catch(err => console.error(err));
        return price;
    } catch (error) {
        console.error("Error fetching token price:", error);
        return null;
    }
}

async function getTokenSupply() {
    try {
        const token = new PublicKey(process.env.TOKEN_ADDRESS);
        const supply = (await connection.getTokenSupply(token)).value.uiAmount;
        return supply;
    } catch (error) {
        console.error("Error fetching token supply:", error);
        return null;
    }
}

async function getPriceChangeRate() {
    const price = await getTokenPrice();
    const currentSupply = await getTokenSupply();
    let previousPrice;
    const pool = await PoolModel.findOne({ poolId: 'birdeye_price' });
    if (pool) {
        previousPrice = pool.priceUsd;
        await PoolModel.updateOne({ poolId: 'birdeye_price' }, { $set: { priceUsd: price, lastSeen: new Date() } });
    } else {
        previousPrice = price;
        const newPool = new PoolModel({
            poolId: 'birdeye_price',
            dexId: 'birdeye',
            priceUsd: price,
            supply: currentSupply,
            lastSeen: new Date(),
        })
        await newPool.save();
    }
    const changedRate = (price / previousPrice) * 100 - 100;
    const supplyChange = ((SUPPLY - currentSupply) / SUPPLY) * 100;

    return { priceChange: changedRate, supplyChange: supplyChange };
}

async function getHourlyPriceChange() {
    const price = await getTokenPrice();
    let previousPrice;
    const pool = await PoolModel.findOne({ poolId: 'hourly_price' });
    if (pool) {
        previousPrice = pool.priceUsd;
        await PoolModel.updateOne({ poolId: 'hourly_price' }, { $set: { priceUsd: price, lastSeen: new Date() } });
    } else {
        previousPrice = price;
        const newPool = new PoolModel({
            poolId: 'hourly_price',
            dexId: 'hourly',
            priceUsd: price,
            lastSeen: new Date(),
        })
        await newPool.save();
    }
    const changedRate = (price / previousPrice) * 100 - 100;
    let rate;

    if (changedRate < 0 && changedRate > -0.1) {
        rate = 0.0;  // Set to 0.0 if the change is a slight decrease
    } else {
        rate = parseFloat(changedRate.toFixed(1));
    }
    
    let mark;
    if (rate > 0) {
        mark = 'green_square';
    } else if(rate === 0) {
        mark = 'yellow_square';
    } else {
        mark = 'red_square';
    }

    return { mark: mark, rate: rate };
}

async function searchPool() {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${process.env.TOKEN_ADDRESS}`); // Replace with the actual API URL
        let pairs = response.data.pairs;
        for (let i = 0; i < pairs.length; i++) {
            const pool = await PoolModel.findOne({ poolId: pairs[i].pairAddress });
            if (pool) {
                await PoolModel.updateOne({ poolId: pairs[i].pairAddress }, { $set: { priceNative: pairs[i].priceNative, priceUsd: pairs[i].priceUsd, liquidity: pairs[i].liquidity.usd, lastSeen: new Date() } });
            } else {
                const newPool = new PoolModel({
                    poolId: pairs[i].pairAddress,
                    poolPair: `${pairs[i].baseToken.symbol}-${pairs[i].quoteToken.symbol}`,
                    dexId: pairs[i].dexId,
                    url: pairs[i].url,
                    priceNative: pairs[i].priceNative,
                    priceUsd: pairs[i].priceUsd,
                    liquidity: pairs[i].liquidity.usd,
                    lastSeen: new Date(),
                })
                await newPool.save();

                const channel = client.channels.cache.get(channelId);
                if (!channel) return console.error("Channel not found");
                const embed = {
                    color: 0x990033,
                    title: '**$TOKE - New Pool Created**',
                    description: `**PoolPair:** ${pairs[i].baseToken.symbol}-${pairs[i].quoteToken.symbol}
                                    **DexID:** ${pairs[i].dexId}
                                    **Liquidity:** $${pairs[i].liquidity.usd.toFixed(2).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
                                    **PoolURL:** ${pairs[i].url}`,
                    thumbnail: {
                        url: `attachment://token-avatar.png`
                    }
                };

                // await channel.send({
                //     embeds: [embed],
                //     files: [{ attachment: path.join(__dirname, 'assets', 'token-avatar.png'), name: 'token-avatar.png' }]
                // });

                await channel.send(`:ocean: **NEW LIQUIDITY POOL**\n\n<:MoonMan_upgrade_Helm:1269655486303698955> **${pairs[i].baseToken.symbol}-${pairs[i].quoteToken.symbol}**\n:identification_card: **${pairs[i].dexId}**\n:dollar: **$${pairs[i].liquidity.usd.toFixed(2).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}**\n:link: ${pairs[i].url}`);
            }
        }
    } catch (error) {
        console.error("Error searching pools:", error);
    }
}

async function postTokenPrice() {
    const channel = client.channels.cache.get(channelId);
    if (!channel) return console.error("Channel not found");

    const price = await getTokenPrice();
    const priceChanged = await getHourlyPriceChange();
    const supply = await getTokenSupply();
    console.log('price ===> ', price, 'supply ===> ', supply, 'market cap ===> ', price * supply, 'mark ===> ', priceChanged.mark, 'rate ===> ', priceChanged.rate);

    if (!price) return;

    // const embed = {
    //     color: 0x0099ff,
    //     title: '**$TOKE - Price**',
    //     description: `*$*${price} *USD*`,
    //     thumbnail: {
    //         url: `attachment://token-avatar.png`
    //     }
    // };

    // await channel.send({
    //     embeds: [embed],
    //     files: [{ attachment: path.join(__dirname, 'assets', 'token-avatar.png'), name: 'token-avatar.png' }]
    // });

    await channel.send(`<:MoonMan_upgrade_Helm:1269655486303698955> **$${price.toFixed(7)}** - :${priceChanged.mark}: **${priceChanged.rate < 0 ? '' : '+'}${priceChanged.rate}%**`);
}

async function postNewDayMessage() {
    const channel = client.channels.cache.get(channelId);
    if (!channel) return console.error("Channel not found");

    const price = await getTokenPrice();
    const supply = await getTokenSupply();
    const change = await getPriceChangeRate();
    const mcap = supply * price;
    const holders = await getTokenHolders();
    console.log('price ===> ', price, 'supply ===> ', supply, 'market cap ===> ', price * supply, 'holders ===> ', holders);
    await searchPool();

    if (!price) return;

    // const embed = {
    //     color: 0x00ff99,
    //     title: '**$TOKE - Mycelium McToken**',
    //     description: `$TOKE is DePIN's very own memecoin and liquidity token with 100% of supply airdropped and a community-run DAO.\n
    //                     **Price:**
    //                     1 - **$${price.toFixed(5)}** - ${roleMention("1219295859049500704")} - [# :hamburger: | mctoken](https://discord.com/channels/1217921180195880970/1217972542569189436/)
    //                     1m - **$${(price * 1000000).toFixed(0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}** - ${roleMention("1219295965710909572")} - [# :moneybag: | mcmillionaire](https://discord.com/channels/1217921180195880970/1217972663809605642/)
    //                     5m - **$${(price * 5000000).toFixed(0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}** - ${roleMention("1219296054042820630")} - [# :whale: | mcwhale](https://discord.com/channels/1217921180195880970/1217949779493916883/)\n
    //                     **Info:**
    //                     Mkt Cap - **$${mcap.toFixed(0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}**
    //                     Supply - **${supply.toFixed(3).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")} (${change.supplyChange.toFixed(3)}%:fire:)**
    //                     Holders - **${holders.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}**`,
    //     thumbnail: {
    //         url: `attachment://token-avatar.png`
    //     }
    // };

    // await channel.send({
    //     embeds: [embed],
    //     files: [{ attachment: path.join(__dirname, 'assets', 'token-avatar.png'), name: 'token-avatar.png' }]
    // });

    await channel.send(`<:MoonMan_upgrade_Helm:1269655486303698955> **DAILY PRICE SUMMARY** ${roleMention("1288185907375243325")}\n\n:hamburger: **$${price.toFixed(5)}** - 1 $TOKE\n:moneybag: **$${(price * 1000000).toFixed(2).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}** - 1m $TOKE\n:whale: **$${(price * 5000000).toFixed(2).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}** - 5m $TOKE\n\n:chart_with_upwards_trend: **$${mcap.toFixed(0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}** - Market Cap\n:coin: **${supply.toFixed(3).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}** - Max Supply\n:fire: **${change.supplyChange.toFixed(3)}%** - Burned\n:man_astronaut: **${holders.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}** - Holders`);
}

async function postBigPriceChanged() {
    let rate = (await getPriceChangeRate()).priceChange;
    if ((rate > 10) || (rate < -10)) {
        let sig = '+';
        if (rate < -10) {
            sig = '-';
        } 
        const channel = client.channels.cache.get(channelId);
        if (!channel) return console.error("Channel not found");
        // const embed = {
        //     color: 0xff9900,
        //     title: '**$TOKE - Price Volatility Detected**',
        //     description: `TOKE ${rate.toFixed(2).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}%`,
        //     thumbnail: {
        //         url: `attachment://token-avatar.png`
        //     }
        // };

        await channel.send(`:zap: **PRICE VOLATILITY**\n<:MoonMan_upgrade_Helm:1269655486303698955> **${sig}${rate.toFixed(2).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}%**`);
    }
}

function truncateToFourDecimals(num) {
    if (Math.sign(num) === -1) {
        // If the number is negative, work with the absolute value and then reapply the sign
        return -truncateToFourDecimals(-num);
    }

    // Convert number to string
    const numStr = num.toString();

    // Check if the number has a decimal part
    const parts = numStr.split('.');
    if (parts.length === 1) {
        // No decimal part, return as is
        return numStr;
    }

    // Get the integral and fraction parts
    const integralPart = parts[0];
    const fractionPart = parts[1];

    // Truncate the fraction part to four digits
    const truncatedFraction = fractionPart.slice(0, 4);

    // Combine the integral part with the truncated fractional part
    return parseFloat(`${integralPart}.${truncatedFraction}`);
}

async function startBot() {
    try {
        await mongoose.connect(process.env.MONGO_URI || "");
        console.log("Connected to MongoDB.");
        client.login(process.env.DISCORD_TOKEN);
    } catch (error) {
        console.error("Error connecting to MongoDB or logging in the bot:", error);
    }
}

startBot();
