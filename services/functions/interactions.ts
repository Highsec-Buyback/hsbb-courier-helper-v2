import {GetCommand, PutCommand, QueryCommand, UpdateCommand} from "@aws-sdk/lib-dynamodb";
import {APIGatewayProxyHandlerV2} from "aws-lambda";
import {InteractionResponseType, InteractionType, verifyKey} from 'discord-interactions';
import {ddb} from "../libs/ddb-client";
import * as sqs from "@aws-sdk/client-sqs";
import {Table} from "@serverless-stack/node/table";
import {Queue} from "@serverless-stack/node/queue";
import {SendMessageCommand} from "@aws-sdk/client-sqs";
import {ulid} from "ulid";
import {CourierResult, HighCountResult, ItemExchangeResult, ResultType} from "./build-couriers";

const DISCORD_PUBLIC_KEY = '168e53eac820a3ecc04d36c9d8a8f230b75c19e59a67ce06f0bae3a3d1f57d1d';

const sqsClient = new sqs.SQSClient({});

function isVerified(headers: any, body: string | undefined): boolean {

    const signature = headers['x-signature-ed25519'];
    const timestamp = headers['x-signature-timestamp'];

    if (!signature || !timestamp || !body) {
        console.warn('Field missing.', {signature, timestamp, body})
        return false;
    }

    return verifyKey(
        body,
        signature,
        timestamp,
        DISCORD_PUBLIC_KEY
    );
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {

    if (!isVerified(event.headers, event.body)) {
        console.warn('Request is not verified')
        return {
            statusCode: 401,
            body: 'invalid request signature',
            headers: {
                'Content-Type': 'text/plain'
            }
        }
    }

    const data = JSON.parse(event.body!);

    console.log(data)

    if (data.type === InteractionType.PING) {
        console.info('Ack PONG')
        return formatJSONResponse({
            type: InteractionResponseType.PONG
        });
    } else if (data.type === InteractionType.APPLICATION_COMMAND) {
        let res: Record<string, unknown>;
        switch (data.data.name) {
            case 'couriers':
                res = await getRecords(data);
                break;
            default:
                res = {
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: {
                        content: `I don't know how to handle the command "${data.data.name}".`,
                        // Make the response visible to only the user running the command
                        flags: 64,
                    }
                };
        }
        return formatJSONResponse(res);
    } else {
        return formatJSONResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
                content: `I don't know what to do!`,
            }
        })
    }
};

function formatJSONResponse(response: any) {
    return {
        statusCode: 200,
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(response)
    }
}

interface JobStatus {
    status: 'ready' | 'working';
    timestamp: number;
    id: string;
}

async function getResponseOrCompletedJob(interactionToken: string, discordId: string): Promise<{ type: number, data: { content: string } } | { id: string, timestamp: number }> {
    const jobStatus: JobStatus = (await ddb.send(new GetCommand({
        TableName: Table.CourierHelperTable.tableName,
        Key: {pk: 'job', sk: 'status'}
    }))).Item as JobStatus ?? {status: 'ready', timestamp: 0, id: 'none'};

    if (jobStatus.status === 'working') {
        return {
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
                content: `I'm still refreshing the data. Please try again later.`,
            }
        };
    }

    const isExpired = new Date(jobStatus.timestamp).getTime() < (new Date().getTime() - 1_000 * 60 * 60);
    if (isExpired) {
        const jobId = ulid();
        await ddb.send(new PutCommand({
            TableName: Table.CourierHelperTable.tableName,
            Item: {
                pk: 'job',
                sk: 'status',
                status: 'working',
                timestamp: new Date().getTime(),
                id: jobId,
            }
        }));

        // trigger job/queue
        await sqsClient.send(new SendMessageCommand({
            QueueUrl: Queue.JobQueue.queueUrl,
            MessageBody: JSON.stringify({interactionToken, jobId, discordId}),
        }));

        // respond
        return {
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
                content: `I need to refresh the data, and will let you know when I'm done. It should take less than 5 minutes.`,
            }
        };
    } else {
        return jobStatus;
    }
}

function getEmoji(courierType: ResultType) {
    switch (courierType) {
        case 'courier':
            return ':truck:';
        case 'item_exchange':
            return ':package:';
        case 'high_count':
            return ':chart_with_upwards_trend:';
        case "logistics_result":
            return ':handshake:';
        case "high_value":
            return ':moneybag:';
        case "island_high_count":
            return ':island: :chart_with_upwards_trend:';
        case "island_generic_result":
            return ':island:';
        case "generic_result":
            return ":gift:";
        default:
            return ':question:';
    }
}

async function getRecords(discordData: any) {
    const {token: interactionToken, member} = discordData;
    const discordId = member.user.id;

    const courierType = discordData.data.options?.find((option: any) => option.name === 'courier-type')?.value;

    const response = await getResponseOrCompletedJob(interactionToken, discordId);

    if ('type' in response) {
        return response;
    } else {

        const allItems: any[] = (await ddb.send(new QueryCommand({
            TableName: Table.CourierHelperTable.tableName,
            KeyConditionExpression: 'pk = :pk and begins_with(sk, :sk)',
            FilterExpression: 'attribute_not_exists(#used)',
            ExpressionAttributeNames: {
                '#used': 'used',
            },
            ExpressionAttributeValues: {
                ':pk': `job#${courierType}`,
                ':sk': `${response.id}#`,
            },
        }))).Items ?? [];

        if (courierType === 'high_count' || courierType === 'island_high_count') {
            allItems.sort((a, b) => b.itemCount - a.itemCount);
        } else if (courierType !== 'item_exchange' && courierType !== 'problem_result') {
            allItems.sort((a, b) => b.collateral - a.collateral);
        }

        const items = allItems.slice(0, 5);

        if (!items.length) {
            return {
                type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                data: {
                    content: `There are no more entries. Please wait until ${new Date(response.timestamp + 1_000 * 60 * 60).toISOString()} and retry.`,
                }
            };
        }

        const formatter = new Intl.NumberFormat('en-US');

        const updatePromises: Promise<any>[] = [];
        for (const item of items) {
            updatePromises.push(ddb.send(new UpdateCommand({
                TableName: Table.CourierHelperTable.tableName,
                Key: {pk: item.pk, sk: item.sk},
                UpdateExpression: 'set #used = :u',
                ExpressionAttributeNames: {
                    '#used': 'used',
                },
                ExpressionAttributeValues: {
                    ':u': true,
                }
            })));
        }
        await Promise.all(updatePromises);

        const embeds = items.map((item) => {
            const fields: any[] = [];
            if (item.customReason ?? item.reason) {
                fields.push({
                    "name": `Info`,
                    "value": item.customReason ?? item.reason,
                    "inline": false
                });
            }
            if (item.provider) {
                fields.push({
                    "name": `Hauler`,
                    "value": item.provider,
                    "inline": false
                });
            }
            if (item.toStation) {
                fields.push({
                    "name": `Destination`,
                    "value": item.toStation,
                    "inline": false
                });
            }
            if (item.reward > 0) {
                fields.push({
                    "name": `Reward`,
                    "value": formatter.format(item.reward),
                    "inline": false
                });
            }
            if (item.collateral) {
                fields.push({
                    "name": `Total ISK in station`,
                    "value": formatter.format(item.collateral),
                    "inline": false
                });
            }
            if (item.recipient) {
                fields.push({
                    "name": `Recipient`,
                    "value": item.recipient,
                    "inline": false
                });
            }
            if (item.itemCount) {
                fields.push({
                    "name": `Item Count`,
                    "value": formatter.format(item.itemCount),
                    "inline": false
                });
            }
            if (item.volume) {
                fields.push({
                    "name": `Volume`,
                    "value": formatter.format(item.volume),
                    "inline": false
                });
            }
            if (item.jumpsToJita) {
                fields.push({
                    "name": `Jumps to Jita`,
                    "value": item.jumpsToJita,
                    "inline": false
                });
            }
            if (item.message) {
                fields.push({
                    "name": `Info`,
                    "value": item.message,
                    "inline": false
                });
            }

            const emoji = getEmoji(courierType);

            const embed: any = {
                "type": "rich",
                "title": item.message ? ':warning: Problem' : `${emoji} ${item.fromRegion} - ${item.fromStation}`,
                "color": 0x00FFFF,
                fields,
            }
            return embed;
        })

        return {
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
                content: ``,
                embeds,
            }
        };
    }
}