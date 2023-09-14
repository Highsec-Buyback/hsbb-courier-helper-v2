import axios from "axios";

const commands = [{
    name: 'couriers',
    type: 1,
    description: 'Get courier suggestions.',
    options: [{
        name: 'courier-type',
        type: 3,
        description: 'Courier type.',
        required: true,
        choices: [{
            value: 'item_exchange',
            name: 'Item Exchanges',
        }, {
            value: 'high_value',
            name: 'High Value (>10b)',
        }, {
            value: 'courier',
            name: 'Well sized couriers',
        }, {
            value: 'high_count',
            name: 'High Count: Stations with more than 500 items',
        }, {
            value: 'island_high_count',
            name: 'Island Stations with more than 3000 items',
        }, {
            value: 'logistics_result',
            name: 'Logistics: A station well suited for #logistics',
        }, {
            value: 'problem_result',
            name: 'A station with problems',
        }, {
            value: 'generic_result',
            name: 'Generic: Something that does not fit the other categories',
        }, {
            value: 'island_generic_result',
            name: 'Island Generic: Something that does not fit the other categories, but for islands',
        }]
    }]
}];

if (!process.env.DISCORD_BOT_TOKEN) {
    throw new Error("Missing DISCORD_BOT_TOKEN");
}

async function getClient() {
    return axios.create({
        baseURL: `https://discord.com/api/v10`,
        headers: {
            Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
            'Accept-Encoding': 'gzip,deflate,compress'
        }
    })
}

async function writeCommands(applicationId: string) {
    const client = await getClient();
    await client.put(`/applications/${applicationId}/commands`, commands);
}

if (!process.env.DISCORD_APPLICATION_ID) {
    throw new Error("Missing DISCORD_APPLICATION_ID");
}

async function register() {
    await writeCommands(process.env.DISCORD_APPLICATION_ID!)
}

register().catch(console.error);