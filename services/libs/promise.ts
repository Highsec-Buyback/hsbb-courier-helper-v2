
export const isFulfilled = <T>(input: PromiseSettledResult<T>): input is PromiseFulfilledResult<T> =>
    input.status === 'fulfilled'

export function isNotNull<T> (arg: T): arg is Exclude<T, null> {
    return arg !== null
}