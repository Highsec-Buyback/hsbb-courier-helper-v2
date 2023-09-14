import {StackContext, Api, Table, Queue, Cron, Function, Bucket} from "@serverless-stack/resources";
import {Duration} from "aws-cdk-lib";

const {AUTH_API, IDENTITY_KEY, ESI_CLIENT_ID, AUTH_APP, JANICE_API_KEY, DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN} = process.env;

if (!AUTH_API) {
    throw new Error("Missing env vars");
}

export function Stack({ stack }: StackContext) {

  const api = new Api(stack, "api", {
    routes: {
      "POST /interactions": {
        function: {
          handler: "functions/interactions.handler",
        }
      },
      "GET /auth": {
        function: {
          handler: "functions/auth.handler",
          timeout: 10,
          environment: {
            AUTH_API: AUTH_API!,
            ESI_CLIENT_ID: ESI_CLIENT_ID!,
            AUTH_APP: AUTH_APP!,
          }
        }
      },
    },
  });
  stack.addOutputs({
    ApiEndpoint: api.url,
  });

  const table = new Table(stack, "CourierHelperTable", {
    fields: {
      pk: "string",
      sk: "string",
    },
    primaryIndex: { partitionKey: "pk", sortKey: "sk" },
    timeToLiveAttribute: 'timeToLive'
  });
  api.bind([table]);

  const queue = new Queue(stack, "JobQueue", {
    consumer: {
      function: {
        handler: "functions/build-couriers.handler",
        timeout: 15 * 60,
        environment: {
          JANICE_API_KEY: JANICE_API_KEY!,
          DISCORD_APPLICATION_ID: DISCORD_APPLICATION_ID!,
          DISCORD_BOT_TOKEN: DISCORD_BOT_TOKEN!,
          IDENTITY_KEY: IDENTITY_KEY!,
        }
      },
    },
    cdk: {
      queue: {
        visibilityTimeout: Duration.minutes(15),
      },
    }
  });
  api.bindToRoute("POST /interactions", [queue]);
  queue.bind([table]);

  const couriersBucket = new Bucket(stack, "CouriersBucket");
  const corporationsCouriersScannerFunction = new Function(stack, 'CorporationsCouriersScannerFunction', {
    handler: "functions/scan-corporation-couriers.handler",
    timeout: 300,
    environment: {
      IDENTITY_KEY: IDENTITY_KEY!,
    }
  });
  const corporationsCouriersScannerCron = new Cron(stack, "CorporationsCouriersScannerCron", {
    schedule: `rate(12 hours)`,
    job: corporationsCouriersScannerFunction,
  });
  corporationsCouriersScannerCron.bind([couriersBucket]);
  api.bind([couriersBucket]);
}
