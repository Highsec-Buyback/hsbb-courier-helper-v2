import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient} from "@aws-sdk/lib-dynamodb";
const rawDdbClient = new DynamoDBClient({});

const marshallOptions = {
    // Whether to automatically convert empty strings, blobs, and sets to `null`.
    convertEmptyValues: true, // false by default.
    // Whether to remove undefined values while marshalling.
    removeUndefinedValues: true, // false by default.
    // Whether to convert typeof object to map attribute.
    convertClassInstanceToMap: true, // false by default.
};

const unmarshallOptions = {
    // Whether to return numbers as a string instead of converting them to native JavaScript numbers.
    wrapNumbers: false, // false, by default.
};

const translateConfig = { marshallOptions, unmarshallOptions };

// Create the DynamoDB Document client.
const ddb = DynamoDBDocumentClient.from(rawDdbClient, translateConfig);

const getPaginatedResults = async(fn) => {
    const EMPTY = Symbol("empty");
    const res = [];
    // @ts-ignore
    for await (const lf of (async function* () {
        let NextMarker = EMPTY;
        let count = 0;
        while (NextMarker || NextMarker === EMPTY) {
            const {marker, results, count: ct} =
                await fn(NextMarker !== EMPTY ? NextMarker : undefined, count);

            yield* results;

            // if there's no marker, then we reached the end
            if (!marker) {
                break;
            }

            NextMarker = marker;
            count = ct;
        }
    })()) {
        res.push(lf);
    }

    return res;
};

export { ddb, getPaginatedResults };