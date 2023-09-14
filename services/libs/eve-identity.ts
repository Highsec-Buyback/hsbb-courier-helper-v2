import axios from "axios";

if (!process.env.IDENTITY_KEY) {
    throw new Error("Missing IDENTITY_KEY");
}

export async function getAccessToken(ownerId: number, minimumDuration: number = 60): Promise<{accessToken: string}> {
    return (await axios.get(`https://uc4v3lk6rh.execute-api.us-east-1.amazonaws.com/dev/app/hsbb-courier-helper-v2/character/${ownerId}/token/?delay=${minimumDuration}`, {
        headers: {
            'x-api-key': process.env.IDENTITY_KEY
        }
    })).data;
}