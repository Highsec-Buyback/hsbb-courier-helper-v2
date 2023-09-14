import {SQSHandler} from "aws-lambda";
import axios, {AxiosInstance} from "axios";
import {ddb} from "../libs/ddb-client";
import {GetCommand, PutCommand, UpdateCommand} from "@aws-sdk/lib-dynamodb";
import {Table} from "@serverless-stack/node/table";
import {fetchData, Item} from "./couriers/fetch-data";
import {getAccessToken} from "../libs/eve-identity";
import {getEsiClient} from "../libs/esi";
import {getLocationInfo} from "./couriers/get-location-info";
import {appraiseWithCaching, janice} from "./couriers/appraise";
import {isFulfilled, isNotNull} from "../libs/promise";
import {calculateRoutes} from "./couriers/calculate-route";
import {ulid} from "ulid";

const {DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN} = process.env;

const discordClient = axios.create({
    baseURL: `https://discord.com/api`,
    headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        'Accept-Encoding': 'gzip,deflate,compress'
    }
});

const CAPITAL_SHIPS = [
    28606, // Orca
    34328, // Bowhead
    20185, // Charon
    20187, // Obelisk
    20189, // Fenrir
    20183, // Providence
]

export const handler: SQSHandler = async (event) => {
    const {interactionToken, jobId, discordId} = JSON.parse(event.Records[0].body);

    // Leave undefined to use the interactionToken for responding
    const discordWebhookUrl = undefined;

    try {
        await axios.get(`https://esi.evetech.net/v2/status/`);
    } catch {
        await ddb.send(new UpdateCommand({
            TableName: Table.CourierHelperTable.tableName,
            Key: {pk: 'job', sk: 'status'},
            UpdateExpression: 'set #status = :s, #timestamp = :t',
            ExpressionAttributeValues: {
                ':s': 'ready',
                ':t': new Date().getTime() + 1_000 * 60 * 10,
            },
            ExpressionAttributeNames: {
                '#status': 'status',
                '#timestamp': 'timestamp'
            }
        }));

        await discordClient.post(discordWebhookUrl ?? `/webhooks/${DISCORD_APPLICATION_ID}/${interactionToken}`, {
            content: `ESI is down. Please try again in 10 minutes.`,
        })
        return;
    }

    let esiClient;
    try {
        const LERSO = 93475128;
        const {accessToken} = await getAccessToken(LERSO, 300);
        esiClient = getEsiClient(accessToken);
    } catch (e) {
        console.error(e);
        await ddb.send(new UpdateCommand({
            TableName: Table.CourierHelperTable.tableName,
            Key: {pk: 'job', sk: 'status'},
            UpdateExpression: 'set #status = :s, #timestamp = :t',
            ExpressionAttributeValues: {
                ':s': 'ready',
                ':t': 0,
            },
            ExpressionAttributeNames: {
                '#status': 'status',
                '#timestamp': 'timestamp'
            }
        }));
        await discordClient.post(discordWebhookUrl ?? `/webhooks/${DISCORD_APPLICATION_ID}/${interactionToken}`, {
            content: `<@${discordId}> Something failed when getting ESI credentials. Please retry, and if the problem persists ping Lerso.`,
        });
        return;
    }

    let stationAssets: Map<number, Item[]>;
    try {
        stationAssets = await fetchData(esiClient)
    } catch (e) {
        console.error(e);
        await ddb.send(new UpdateCommand({
            TableName: Table.CourierHelperTable.tableName,
            Key: {pk: 'job', sk: 'status'},
            UpdateExpression: 'set #status = :s, #timestamp = :t',
            ExpressionAttributeValues: {
                ':s': 'ready',
                ':t': 0,
            },
            ExpressionAttributeNames: {
                '#status': 'status',
                '#timestamp': 'timestamp'
            }
        }));
        await discordClient.post(discordWebhookUrl ?? `/webhooks/${DISCORD_APPLICATION_ID}/${interactionToken}`, {
            content: `<@${discordId}> Failed to load assets from ESI. Please retry, and if the problem persists ping Lerso.`,
        });
        return;
    }

    try {
        const promises: Promise<AnyResult | null>[] = [];
        for (const [stationId, items] of stationAssets) {
            promises.push(processStationAssets(esiClient, {stationId, items}))
        }
        const settled = await Promise.allSettled(promises);
        const processedStationAssets: AnyResult[] = settled
            .filter(isFulfilled)
            .map(({value}) => value)
            .filter(isNotNull);

        console.log({processedStationAssets: processedStationAssets.filter((x) => x).length});

        const writePromises: Promise<any>[] = [];
        for (const job of processedStationAssets) {
            if (!job) {
                continue;
            }
            writePromises.push(ddb.send(new PutCommand({
                TableName: Table.CourierHelperTable.tableName,
                Item: {
                    pk: `job#${job.type}`,
                    sk: `${jobId}#${ulid()}`,
                    ...job,
                    // Delete items after a day
                    timeToLive: Math.floor(new Date().getTime() / 1_000 + 60 * 60 * 24)
                }
            })));
        }
        console.log(`writing ${writePromises.length} results`)
        await Promise.all(writePromises);

        await ddb.send(new UpdateCommand({
            TableName: Table.CourierHelperTable.tableName,
            Key: {pk: 'job', sk: 'status'},
            UpdateExpression: 'set #status = :s, #timestamp = :t',
            ExpressionAttributeValues: {
                ':s': 'ready',
                ':t': new Date().getTime(),
            },
            ExpressionAttributeNames: {
                '#status': 'status',
                '#timestamp': 'timestamp'
            }
        }));

        const counts: Record<ResultType, number> = {
            item_exchange: processedStationAssets.filter((x) => x.type === 'item_exchange').length,
            high_value: processedStationAssets.filter((x) => x.type === 'high_value').length,
            high_count: processedStationAssets.filter((x) => x.type === 'high_count').length,
            courier: processedStationAssets.filter((x) => x.type === 'courier').length,
            logistics_result: processedStationAssets.filter((x) => x.type === 'logistics_result').length,
            generic_result: processedStationAssets.filter((x) => x.type === 'generic_result').length,
            island_high_count: processedStationAssets.filter((x) => x.type === 'island_high_count').length,
            island_generic_result: processedStationAssets.filter((x) => x.type === 'island_generic_result').length,
            problem_result: processedStationAssets.filter((x) => x.type === 'problem_result').length,
        };

        await discordClient.post(discordWebhookUrl ?? `/webhooks/${DISCORD_APPLICATION_ID}/${interactionToken}`, {
            content: `<@${discordId}> Processing complete. Here are the stats:\n\n${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('\n')}`,
        });
    } catch (e) {
        console.error(e);
        await discordClient.post(discordWebhookUrl ?? `/webhooks/${DISCORD_APPLICATION_ID}/${interactionToken}`, {
            content: `<@${discordId}> Something failed. Please ping Lerso.`,
        });
    }
};

const mainlandService = axios.create({
    baseURL: `https://bl8q6dawb3.execute-api.us-east-1.amazonaws.com/prod`
});

type AnyResult =
    HighValueResult | // 20b and more
    CourierResult | // well sized couriers that I can create or hand off (but if it already fits and has a destination, why hand it out? it's only more clicks when we hand that out)
    ItemExchangeResult | // item exchanges to repackage ships that I can create
    HighCountResult | // stations with too many items that we need to hand off. making the cutoff at 1000 items, so that we can still hand over stations with just 2 contracts.
    IslandHighCountResult | // same as HighCountResult, but for islands. Starting at 3000 items because we need to travel there for stacking.
    LogisticsResult | // a location that we should hand off to #logistcs, can have up to 1000 items
    IslandGenericResult | // same as generic result, but for islands
    GenericResult | // just the station, item count, volume, collateral, and jita jumps (does include islands)
    ProblemResult; // something went wrong, record an error message

export type ResultType =
    'high_value' |
    'courier' |
    'item_exchange' |
    'high_count' |
    'island_high_count' |
    'logistics_result' |
    'generic_result' |
    'island_generic_result' |
    'problem_result';

interface Result {
    type: ResultType;
    isIsland?: boolean;
    jumpsToJita?: number;
}

export interface HighValueResult extends Result {
    type: 'high_value';
    collateral: number;
    fromRegion: string;
    fromStation: string;
}

export interface CourierResult extends Result {
    type: 'courier';
    customReason?: string;
    provider: string;
    reward: number;
    collateral: number;
    fromRegion: string;
    fromStation: string;
    toStation: string;
}

export interface ItemExchangeResult extends Result {
    type: 'item_exchange';
    reason: string;
    recipient: string;
    fromRegion: string;
    fromStation: string;
}

export interface HighCountResult extends Result {
    type: 'high_count';
    fromRegion: string;
    fromStation: string;
    itemCount: number;
    collateral: number;
    volume: number;
}

export interface IslandHighCountResult extends Result {
    type: 'island_high_count';
    fromRegion: string;
    fromStation: string;
    collateral: number;
    volume: number;
    itemCount: number;
}

export interface LogisticsResult extends Result {
    type: 'logistics_result';
    fromRegion: string;
    fromStation: string;
    collateral: number;
    volume: string;
    itemCount: number;
}

export interface IslandGenericResult extends Result {
    type: 'island_generic_result';
    fromRegion: string;
    fromStation: string;
    collateral: number;
    volume: string;
    itemCount: number;
}

export interface GenericResult extends Result {
    type: 'generic_result';
    fromRegion: string;
    fromStation: string;
    collateral: number;
    volume: string;
    itemCount: number;
}

export interface ProblemResult extends Result {
    type: 'problem_result';
    message: string;
}

const STATION_ID_THRESHOLD = 61_000_000;

async function processStationAssets(esiClient: AxiosInstance, stationAssets: { stationId: number, items: Item[] }): Promise<AnyResult | null> {
    if (stationAssets.stationId > STATION_ID_THRESHOLD) {

        const {link} = await createAppraisal(stationAssets.items, esiClient);

        return {
            type: 'problem_result',
            message: `Station <${stationAssets.stationId}> is not in NPC station ID range. Assets: <${link}>`,
        };
    }
    const locationInfo = await getLocationInfo(esiClient, stationAssets.stationId);
    const isHighsec = locationInfo.securityStatus >= 0.45;
    const itemCount = stationAssets.items.length;

    const {stationName, regionName} = locationInfo;

    if (!isHighsec) {
        return {
            type: 'problem_result',
            message: `${stationName} (${regionName}) is not in highsec (security: ${locationInfo.securityStatus}).`,
        };
    }
    const hasCapitalShip = stationAssets.items.some(({typeId}) => CAPITAL_SHIPS.includes(typeId));
    if (hasCapitalShip) {
        return {
            type: 'problem_result',
            message: `${stationName} (${regionName}) contains a capital ship.`,
        };
    }

    let hasAssembledShip = false;
    for (const item of stationAssets.items.filter(({isSingleton}) => isSingleton)) {
        if (await isShip({...item, esiClient})) {
            console.log('Station contains a fitted ship', {stationName, stationId: stationAssets.stationId});
            return {
                type: 'item_exchange',
                reason: 'contains_fitted_ship',
                recipient: 'Lurbu Orlenard',
                fromRegion: regionName,
                fromStation: stationName,
            }
        }
    }

    const {totals} = await appraiseWithCaching(stationAssets.stationId, stationAssets.items, hasAssembledShip);

    const mainlandRes = await mainlandService.get(`/mainland?systemName=${locationInfo.systemName}`);
    const isIsland = !mainlandRes?.data?.isMainland;

    if (isIsland) {
        if (itemCount > 3000) {
            return {
                type: 'island_high_count',
                fromRegion: locationInfo.regionName,
                fromStation: locationInfo.stationName,
                itemCount,
                collateral: totals.buy,
                volume: totals.volume,
            };
        } else if (totals.buy > 100_000_000) {
            return {
                type: 'island_generic_result',
                fromRegion: locationInfo.regionName,
                fromStation: locationInfo.stationName,
                itemCount,
                collateral: totals.buy,
                volume: totals.volume,
            };
        } else {
            // ignore island stations with less than 100m collateral
            return null;
        }
    }

    const routes = await calculateRoutes(locationInfo.systemName, locationInfo.regionName);
    if (!routes.length) {
        console.log('Skipping station because there is no highsec route', {...locationInfo, reason: 'no route'});
        return {
            type: 'problem_result',
            message: `${stationName} (${locationInfo.regionName}) has no highsec route, but should not be on an island. ${new Date().toISOString()}`,
        };
    }
    const jitaRoute = routes.find(({destinationSystemName}) => destinationSystemName === 'Jita');
    const jumpsToJita = jitaRoute?.jumps ?? -1;

    const shortestRoute = routes.sort((a, b) => a.jumps - b.jumps)[0];

    if (totals.buy < 100_000_000) {
        // ignore stations with less than 100m collateral
        return null;
    } else if (itemCount > 500) {
        return {
            type: 'high_count',
            fromRegion: locationInfo.regionName,
            fromStation: locationInfo.stationName,
            itemCount,
            collateral: totals.buy,
            volume: totals.volume,
            jumpsToJita: jitaRoute?.jumps,
        };
    } else if (totals.buy > 3_000_000_000 && totals.volume > 62_500 && jumpsToJita <= 30) {
        return {
            type: 'logistics_result',
            fromRegion: locationInfo.regionName,
            fromStation: locationInfo.stationName,
            itemCount,
            collateral: totals.buy,
            volume: totals.volume,
        }
    } else if (totals.sell > 10_000_000_000) {
        return {
            type: "high_value",
            collateral: totals.sell,
            fromRegion: locationInfo.regionName,
            fromStation: locationInfo.stationName,
            jumpsToJita: jitaRoute?.jumps,
        };
    } else if (totals.volume > 845_000) {
        return {
            type: 'courier',
            provider: 'bulky',
            customReason: 'This station contains more than we can fit in a freighter. Please pick some items to fill a freighter courier (up to 845km3) with close to 1.5b ISK in value if possible. If you can put at least 1.4b ISK in, send it straight to Jita, otherwise send it to the nearest hub.',
            reward: -1,
            collateral: totals.buy,
            fromRegion: locationInfo.regionName,
            fromStation: locationInfo.stationName,
            toStation: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
            jumpsToJita: jitaRoute?.jumps,
        };
    } else if (jitaRoute && jitaRoute.jumps >= 30 && totals.volume > 600_000 && totals.sell > 1_400_000_000 && totals.sell <= 1_550_000_000) {
        // Prefer Red Frog on large long hauls
        return {
            type: 'courier',
            provider: 'Red Frog Freight',
            reward: (jitaRoute.jumps + 5) * 1_000_000,
            collateral: Math.min(totals.sell, 1_500_000_000),
            fromRegion: locationInfo.regionName,
            fromStation: locationInfo.stationName,
            toStation: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
        };
    } else if (totals.sell >= 500_000_000 && totals.volume > 62_500 && totals.sell <= 1_550_000_000 && totals.volume <= 845_000) {
        // Freighters
        const selectedRoute = (jitaRoute && jitaRoute.jumps <= 20) ? jitaRoute : shortestRoute;

        const pushxFeeRaw = (selectedRoute.jumps + 1) * 1_000_000;
        const pushxFeeFinal = pushxFeeRaw > 4_500_000 ? pushxFeeRaw : 4_500_000;
        const redFrogFee = (selectedRoute.jumps + 5) * 1_000_000;
        if (selectedRoute.jumps < 20 && (pushxFeeRaw / totals.sell < 0.02)) {
            return {
                type: 'courier',
                provider: 'Push Industries',
                reward: pushxFeeFinal,
                collateral: Math.min(totals.sell, 1_500_000_000),
                fromRegion: locationInfo.regionName,
                fromStation: locationInfo.stationName,
                toStation: selectedRoute.destinationStructureName,
            };
        } else if (redFrogFee / totals.sell < 0.02) {
            return {
                type: 'courier',
                provider: 'Red Frog Freight',
                reward: redFrogFee,
                collateral: Math.min(totals.sell, 1_500_000_000),
                fromRegion: locationInfo.regionName,
                fromStation: locationInfo.stationName,
                toStation: selectedRoute.destinationStructureName,
            };
        } else {
            // Don't return a guidance if the hauling cost exceeds 2%
            console.log('Skipping station because the hauling cost exceeds 2%', {...locationInfo, selectedRoute, reason: 'freighter, exceeds 2%'});
            return {
                type: 'generic_result',
                fromRegion: locationInfo.regionName,
                fromStation: locationInfo.stationName,
                collateral: totals.buy,
                volume: totals.volume,
                itemCount,
            };
        }
    } else if (totals.volume <= 62_500) {
        const calculatedFee = shortestRoute.jumps * 1_000_000;
        if (calculatedFee / totals.sell > 0.02) {
            // Don't return a guidance if the hauling cost exceeds 2%
            console.log('Skipping station because the public courier cost exceeds 2%', {...locationInfo, reason: 'public courier, exceeds 2%'});
            return {
                type: 'generic_result',
                fromRegion: locationInfo.regionName,
                fromStation: locationInfo.stationName,
                collateral: totals.buy,
                volume: totals.volume,
                itemCount,
            };
        }

        return {
            type: 'courier',
            provider: 'Public',
            reward: calculatedFee,
            collateral: Math.floor((totals.sell + totals.buy) / 2),
            fromRegion: locationInfo.regionName,
            fromStation: locationInfo.stationName,
            toStation: shortestRoute.destinationStructureName,
        };
    } else {
        return {
            type: 'generic_result',
            fromRegion: locationInfo.regionName,
            fromStation: locationInfo.stationName,
            collateral: totals.buy,
            volume: totals.volume,
            itemCount,
        };
    }
}

export async function createAppraisal(items: {typeId: number, quantity: number}[], esiClient: any): Promise<{link: string}> {
    const itemInfos = await Promise.all(items.map(({typeId}) => getItemInfo({
        typeId,
        esiClient
    }, (item: any) => item.name === undefined)));
    const bodyRecords = [];
    for (const item of items) {
        const {name} = itemInfos.find((itemInfo) => itemInfo.typeId === item.typeId);
        bodyRecords.push(`${name} x${item.quantity}`);
    }
    const body = bodyRecords.join('\n');
    const appraisal = (await janice.post('/v2/appraisal', body)).data;
    return {
        link: `https://janice.e-351.com/a/${appraisal.code}`
    }
}

async function getItemInfo({typeId, esiClient}: any, forceCheck: (item: any) => boolean = () => false): Promise<any> {
    const item = (await ddb.send(new GetCommand({
        TableName: Table.CourierHelperTable.tableName,
        Key: {pk: 'item-info', sk: `${typeId}`}
    }))).Item;
    if (!item || forceCheck(item)) {
        const {group_id} = (await esiClient.get(`/v3/universe/types/${typeId}/`)).data;
        const {category_id} = (await esiClient.get(`/v1/universe/groups/${group_id}/`)).data;
        const isShip = category_id === 6;

        const {name} = (await esiClient.get(`/v3/universe/types/${typeId}/`)).data;

        await ddb.send(new PutCommand({
            TableName: Table.CourierHelperTable.tableName,
            Item: {pk: 'item-info', sk: `${typeId}`, typeId, isShip, name}
        }));
    }
}

async function isShip({typeId, esiClient}: any): Promise<boolean | undefined> {
    const {isShip} = await getItemInfo({typeId, esiClient}, (item: any) => item.isShip === undefined);
    return isShip;
}


