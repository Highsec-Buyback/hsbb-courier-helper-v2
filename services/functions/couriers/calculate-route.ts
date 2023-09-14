import axios from "axios";
import {isFulfilled} from "../../libs/promise";
import {ddb} from "../../libs/ddb-client";
import {GetCommand, PutCommand} from "@aws-sdk/lib-dynamodb";
import {Table} from "@serverless-stack/node/table";

export const HUBS = [
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
];

export async function calculateRoutes(systemName: string, regionName: string): Promise<{ destinationStructureName: string, destinationSystemName: string, jumps: number }[]> {
    const promises: Promise<RouteResponse>[] = HUBS.map((hub) => getRouteInfoNames(systemName, hub.systemName, hub.name));
    const routes = (await Promise.allSettled(promises))
        .filter(isFulfilled)
        .map((r) => r.value)
        .map((r: RouteResponse) => {
            const name = HUBS.find((h) => h.systemId === r.destinationId)!.name;
            return {
                destinationStructureName: name,
                destinationSystemName: r.destination,
                jumps: r.jumps,
            }
        });
    console.log({routes});
    return routes;
}

interface RedFrogResponse {
    jumps: number;
    reward_base: number;
    origin_name: string;
    origin_id: number;
    destination_name: string;
    destination_id: number;
}

export interface RouteResponse {
    jumps: number,
    rffPrice: number,
    origin: string,
    destination: string,
    destinationStructureName: string,
    destinationId: number
}

export async function getRouteInfoNames(origin: string, destination: string, destinationStructureName: string): Promise<RouteResponse> {
    const existing = (await ddb.send(new GetCommand({
        TableName: Table.CourierHelperTable.tableName,
        Key: {pk: 'route', sk: `${origin}#${destination}`}
    }))).Item as RouteResponse;

    if (existing) {
        return existing;
    } else {
        console.log(`Asking RedFrog for route from ${origin} to ${destination}`)
        const r = (await axios.get<RedFrogResponse>(`https://red-frog.org/api/public/v1/calculator/red/?origin=${origin}&destination=${destination}`)).data;
        const routeResponse = {
            jumps: r.jumps,
            rffPrice: r.reward_base,
            origin,
            destination,
            destinationId: r.destination_id,
            destinationStructureName: destinationStructureName,
        };
        await ddb.send(new PutCommand({
            TableName: Table.CourierHelperTable.tableName,
            Item: {
                pk: 'route',
                sk: `${origin}#${destination}`,
                ...routeResponse
            },
        }));
        return routeResponse;
    }
}
