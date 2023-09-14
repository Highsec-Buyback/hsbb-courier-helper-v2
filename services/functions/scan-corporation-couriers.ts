import axios, {AxiosInstance} from "axios";
import {getEsiClient} from "../libs/esi";
import {getAccessToken} from "../libs/eve-identity";
import {Bucket} from "@serverless-stack/node/bucket";
import {PutObjectCommand, S3Client} from "@aws-sdk/client-s3";

const s3 = new S3Client({});

const LERSO = 93475128;
const HSBB = 98649014;

// Run every 12 hours, because we're only taking snapshot of couriers.
// Couriers that are accepted within 12 hours are exceptionally good, so we
// don't need to let them influence our stats.
export const handler = async () => {
    try {
        await axios.get(`https://esi.evetech.net/v2/status/`);
    } catch {
        console.log('ESI is down.')
        return;
    }

    const {accessToken} = await getAccessToken(LERSO, 300);
    const esiClient = getEsiClient(accessToken);
    await fetchContractsToS3(esiClient);
};

async function fetchContractsToS3(esiClient: AxiosInstance): Promise<void> {
    console.log('enter getContracts', {})

    const contractsHead = await esiClient.head(`/v1/corporations/${HSBB}/contracts/`);
    const pageCount = +contractsHead.headers['x-pages'];
    console.log('getContracts', {pageCount, headers: contractsHead.headers})

    const allCouriers: any[] = [];
    for (let i = 0; i < pageCount; i++) {
        console.log('getContracts loading page', i + 1)
        const contractsPage = (await esiClient.get(`/v1/corporations/${HSBB}/contracts?page=${i + 1}`)).data;
        const couriers = contractsPage.filter((contract: any) => contract.type === 'courier');
        allCouriers.push(...couriers);
    }

    await s3.send(new PutObjectCommand({
        Bucket: Bucket.CouriersBucket.bucketName,
        Body: JSON.stringify(allCouriers),
        Key: `${HSBB}/${new Date().getTime()}`
    }));

    const outstandingCouriers = allCouriers
        .filter((contract: any) => contract.status === 'outstanding');
    const map = new Map<string, number>();
    for (const outstandingCourier of outstandingCouriers) {
        const key = `${outstandingCourier.assignee_id}`;
        map.set(key, (map.get(key) || 0) + 1);
    }

    const jsonObject: string = JSON.stringify(Array.from(map).reduce((obj, [key, value]) => {
        // @ts-ignore
        obj[key] = value;
        return obj;
    }, {}));

    console.log(jsonObject)

    await s3.send(new PutObjectCommand({
        Bucket: Bucket.CouriersBucket.bucketName,
        Body: jsonObject,
        Key: `${HSBB}/today-stats`
    }));

    console.log('end getContracts', {})
}