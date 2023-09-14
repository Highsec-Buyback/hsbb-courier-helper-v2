import axios from "axios";

export function getEsiClient(token: string) {
    return axios.create({
        baseURL: 'https://esi.evetech.net',
        headers: {
            Authorization: `Bearer ${token}`,
            'Accept-Encoding': 'gzip,deflate,compress'
        },
        validateStatus: function (status) {
            // default || 304=etag matches
            return status >= 200 && status < 300 || status === 304;
        },
    })
}