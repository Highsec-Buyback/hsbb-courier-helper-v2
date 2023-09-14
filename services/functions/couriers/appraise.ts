import * as crypto from "crypto";
import {ddb} from "../../libs/ddb-client";
import {GetCommand, PutCommand} from "@aws-sdk/lib-dynamodb";
import {Table} from "@serverless-stack/node/table";
import {getJaniceClient} from "../../libs/janice";

export async function appraiseWithCaching(locationId: number, items: any[], hasAssembledShip: boolean) {
    const buf = JSON.stringify(items);
    const eTag = crypto.createHash('md5').update(buf).digest('hex');

    const oldEtagRecord = (await ddb.send(new GetCommand({
        TableName: Table.CourierHelperTable.tableName,
        Key: {
            pk: 'snapshots',
            sk: `${locationId}`
        }
    }))).Item;

    if (oldEtagRecord?.eTag === eTag) {
        return {
            totals: oldEtagRecord.totals,
            hasAssembledShip: oldEtagRecord.hasAssembledShip,
        };
    }

    const {totals} = await appraise(items);

    await ddb.send(new PutCommand({
        TableName: Table.CourierHelperTable.tableName,
        Item: {
            pk: 'snapshots',
            sk: `${locationId}`,
            stationId: locationId,
            eTag,
            totals,
            hasAssembledShip,
            timeToLive: Math.floor(new Date().getTime() / 1_000 + 60 * 60 * 24 * 7),
        }
    }));

    return {totals, hasAssembledShip};
}

export const janice = getJaniceClient();

export async function appraise(items: {typeId: number, quantity: number}[]): Promise<{totals: {buy: number, sell: number, volume: number}}> {
    try {
        const formattedItems = items.map((item) => {
            return {
                type_id: item.typeId,
                quantity: item.quantity,
            }
        });

        const typeIds = [...new Set(formattedItems.map((item) => item.type_id))];
        const amountPerType = new Map<number, number>();

        for (const formattedItem of formattedItems) {
            amountPerType.set(formattedItem.type_id, (amountPerType.get(formattedItem.type_id) ?? 0) + formattedItem.quantity);
        }

        const {data} = await janice.post(`/v2/pricer`, typeIds.map((typeId) => `${typeId}`).join('\n'), {
            headers: {
                'Content-Type': 'text/plain'
            }
        });

        const totalBuy = data.map((item: any) => item.immediatePrices.buyPrice * (amountPerType.get(item.itemType.eid) ?? 0)).reduce((a: number, b: number) => a + b, 0);
        const totalSell = data.map((item: any) => item.immediatePrices.sellPrice * (amountPerType.get(item.itemType.eid) ?? 0)).reduce((a: number, b: number) => a + b, 0);
        const totalVolume = data.map((item: any) => item.itemType.packagedVolume * (amountPerType.get(item.itemType.eid) ?? 0)).reduce((a: number, b: number) => a + b, 0);

        return {
            totals: {
                buy: totalBuy,
                sell: totalSell,
                volume: totalVolume,
            },
        };
    } catch (e) {
        console.log('janice FAIL', e)
        throw e;
    }
}