import axios from "axios";
import axiosRetry from "axios-retry";

axios.interceptors.response.use(function (response) {
    return response;
}, function (error) {
    if (error.response) {
        console.error(error.response.status, error.response.data);
    } else {
        console.error(error);
    }
    return Promise.reject(error);
});

axiosRetry(axios, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => !!error.status && (error.status >= 500),
});

export function getJaniceClient() {
    return axios.create({
        baseURL: `https://janice.e-351.com/api/rest`,
        headers: {
            'X-ApiKey': process.env.JANICE_API_KEY,
            'Accept-Encoding': 'gzip,deflate,compress',
            'User-Agent': 'Lerso Nardieu from Highsec Buyback (Courier Helper V2)',
        }
    })
}