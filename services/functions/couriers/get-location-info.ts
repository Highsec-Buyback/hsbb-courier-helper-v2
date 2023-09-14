import {AxiosInstance} from "axios";
import {Table} from "@serverless-stack/node/table";
import {GetCommand, PutCommand} from "@aws-sdk/lib-dynamodb";
import {ddb} from "../../libs/ddb-client";

interface LocationInfoResponse {
    locationId: number,
    systemId: number,
    stationName: string,
    securityStatus: number,
    systemName: string,
    regionName: string,
    stationId: number;
}

export async function getLocationInfo(esiClient: AxiosInstance, locationId: number): Promise<LocationInfoResponse> {
    const existingInfo = (await ddb.send(new GetCommand({
        TableName: Table.CourierHelperTable.tableName,
        Key: {pk: 'location-info', sk: `${locationId}`}
    }))).Item as LocationInfoResponse;
    if (existingInfo) {
        return existingInfo;
    }

    const locationResponse = locationId > STATION_ID_THRESHOLD ?
        await esiClient.get(`/v2/universe/structures/${locationId}/`) :
        await esiClient.get(`/v2/universe/stations/${locationId}/`);
    const stationName = locationResponse.data.name;
    const systemId = locationId > STATION_ID_THRESHOLD ? locationResponse.data.solar_system_id : locationResponse.data.system_id;

    const {
        security_status: securityStatus,
        name: systemName,
        constellation_id
    } = (await esiClient.get(`/v4/universe/systems/${systemId}/`)).data;
    const {region_id} = (await esiClient.get(`/v1/universe/constellations/${constellation_id}/`)).data;
    const {name: regionName} = (await esiClient.get(`/v1/universe/regions/${region_id}/`)).data;

    const result: LocationInfoResponse = {
        stationId: locationId,
        locationId,
        systemId,
        stationName,
        securityStatus,
        systemName,
        regionName,
    };

    await ddb.send(new PutCommand({
        TableName: Table.CourierHelperTable.tableName,
        Item: {
            pk: 'location-info',
            sk: `${locationId}`,
            ...result
        },
    }));

    return result;
}

const STATION_ID_THRESHOLD = 61_000_000;
