import {AxiosInstance} from "axios";

const IGNORE = [
    {
        name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
        systemName: 'Jita',
        systemId: 30000142,
        stationId: 60003760,
    }, {
        name: 'Hek VIII - Moon 12 - Boundless Creation Factory',
        systemName: 'Hek',
        systemId: 30002053,
        stationId: 60005686
    }, {
        name: 'Rens VI - Moon 8 - Brutor Tribe Treasury',
        systemName: 'Rens',
        systemId: 30002510,
        stationId: 60004588
    }, {
        name: 'Amarr VIII (Oris) - Emperor Family Academy',
        systemName: 'Amarr',
        systemId: 30002187,
        stationId: 60008494
    }, {
        name: 'Dodixie IX - Moon 20 - Federation Navy Assembly Plant',
        systemName: 'Dodixie',
        systemId: 30002659,
        stationId: 60011866,
    },
    {
        name: 'Jita',
        systemId: 30000142,
        stationId: 60003760
    },
    {
        name: 'Amarr',
        systemId: 30002187,
        stationId: 60008494
    },
    {
        name: 'Arlulf III - Moon 10 - CONCORD Bureau',
        systemId: 30003374,
        stationId: 60012355,
    }
];

const IGNORE_IDS = IGNORE.map((s) => s.stationId);

const HSBB = 98649014;

const STATION_ID_LOWER_BOUND = 60_000_000;

export interface Item {
    itemId: number,
    locationType: string,
    locationId: number,
    quantity: number,
    typeId: number,
    isSingleton: boolean,
    stationId: number;
}

export async function fetchData(esiClient: AxiosInstance): Promise<Map<number, Item[]>> {

    console.log('retrieving assets');
    const rawItems = [];
    const assetsHead = await esiClient.head(`/v5/corporations/${HSBB}/assets/`);
    const assetsPromises = [];
    for (let i = 1; i <= +assetsHead.headers['x-pages']; i++) {
        assetsPromises.push(esiClient.get(`/v5/corporations/${HSBB}/assets/?page=${i}`));
    }
    for (const page of await Promise.all(assetsPromises)) {
        rawItems.push(...page.data);
    }
    console.log('assets count', rawItems.length);

    let items: any[] = rawItems
        .filter((item) => !['Unlocked', 'Wardrobe', 'AssetSafety', 'Implant', 'Skill'].includes(item.location_flag))
        .map((item) => {
            return {
                itemId: item.item_id,
                locationType: item.location_type,
                locationId: item.location_id,
                quantity: item.quantity,
                typeId: item.type_id,
                isSingleton: item.is_singleton,
            }
        });

    // tree building
    items = await addStationIds(items);

    console.log({itemsWithStations: items.length})


    console.log('grouping items by station')
    // resolve stations
    // <stationId, items> (station can also be a structure)
    const itemsPerStation = new Map<number, any[]>();
    for (const item of items) {
        // If the stationId is out of the lower range, then the assets are in space or so
        if (!item.stationId || item.stationId < STATION_ID_LOWER_BOUND || IGNORE_IDS.includes(item.stationId)) {
            continue;
        }

        const items = [...itemsPerStation.get(item.stationId) ?? [], item];
        itemsPerStation.set(item.stationId, items);
    }
    console.log({stationCount: itemsPerStation.size});

    return itemsPerStation;
}

async function addStationIds(items: any[]): Promise<any[]> {
    const itemMap = new Map<number, any>();
    for (const item of items) {
        itemMap.set(item.itemId, item);
    }
    const rootItems = new Map<number, any>();
    for (const item of items) {
        if (!itemMap.has(item.locationId)) {
            rootItems.set(item.itemId, item);
        }
    }
    const locationIds = new Set<number>();
    for (const [_, item] of rootItems) {
        locationIds.add(item.locationId);
    }
    const accessibleLocationIds = new Set([...locationIds]);
    for (const item of items) {
        item.stationId = resolveStationRecursive(item, rootItems, itemMap, accessibleLocationIds);
    }
    return items;
}

function resolveStationRecursive(item: any, rootItems: Map<number, any>, itemMap: Map<number, any>, accessibleLocations: Set<number>): number | null {
    if (rootItems.has(item.itemId)) {
        if (accessibleLocations.has(item.locationId)) {
            return item.locationId;
        } else {
            return null;
        }
    } else {
        return resolveStationRecursive(itemMap.get(item.locationId), rootItems, itemMap, accessibleLocations);
    }
}
