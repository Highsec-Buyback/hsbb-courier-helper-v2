import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import axios from "axios";
import {PutCommand} from "@aws-sdk/lib-dynamodb";
import {ddb} from "../libs/ddb-client";
import {Table} from "@serverless-stack/node/table";

const {AUTH_API, ESI_CLIENT_ID, AUTH_APP} = process.env;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {

  if (!event.queryStringParameters?.code) {

    const callbackUrl = `https://rub7meyc7g.execute-api.us-east-1.amazonaws.com/auth`;
    const scopes = ['esi-location.read_location.v1', 'esi-clones.read_clones.v1', 'esi-assets.read_assets.v1', 'esi-location.read_online.v1', 'esi-contracts.read_character_contracts.v1'];
    if (event.queryStringParameters?.admin === 'true') {
      scopes.push('esi-assets.read_corporation_assets.v1', 'esi-contracts.read_corporation_contracts.v1')
    }
    const signinUrl = `https://login.eveonline.com/v2/oauth/authorize/?response_type=code&redirect_uri=${encodeURIComponent(callbackUrl)}&client_id=${ESI_CLIENT_ID}&state=nothing&scope=${encodeURIComponent(scopes.join(' '))}`;

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html" },
      body: `<a href="${signinUrl}">Sign in</a>`,
    };
  }

  const {data} = await axios.get(`${AUTH_API}?code=${event.queryStringParameters!.code}&appId=${AUTH_APP}`);

  await ddb.send(new PutCommand({
    TableName: Table.CourierHelperTable.tableName,
    Item: {
      pk: 'characters',
      sk: `${data.characterId}`,
      characterId: data.characterId,
      characterName: data.name,
    }
  }));

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/plain" },
    body: `Done!`,
  };
};
