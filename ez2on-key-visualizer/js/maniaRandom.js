const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const SEED_ARRAY_LENGTH = 56;

class CsharpRandom {
    #seedArray = new Int32Array(SEED_ARRAY_LENGTH);
    #inext = 0;
    #inextp = 21;

    constructor(seed) {
        const subtraction = seed === INT32_MIN ? INT32_MAX : Math.abs(seed);
        let mj = 161803398 - subtraction;
        let mk = 1;
        let ii = 0;

        this.#seedArray[55] = mj;

        for (let i = 1; i < 55; i++) {
            ii += 21;
            if (ii >= 55) ii -= 55;

            this.#seedArray[ii] = mk;
            mk = (mj - mk) | 0;
            if (mk < 0) mk += INT32_MAX;
            mj = this.#seedArray[ii];
        }

        for (let pass = 1; pass < 5; pass++) {
            for (let i = 1; i < SEED_ARRAY_LENGTH; i++) {
                let offset = i + 30;
                if (offset >= 55) offset -= 55;

                let value = (this.#seedArray[i] - this.#seedArray[1 + offset]) | 0;
                if (value < 0) value += INT32_MAX;
                this.#seedArray[i] = value;
            }
        }
    }

    next() {
        let inext = this.#inext + 1;
        if (inext >= SEED_ARRAY_LENGTH) inext = 1;

        let inextp = this.#inextp + 1;
        if (inextp >= SEED_ARRAY_LENGTH) inextp = 1;

        let value = this.#seedArray[inext] - this.#seedArray[inextp];
        if (value === INT32_MAX) value--;
        if (value < 0) value += INT32_MAX;

        this.#seedArray[inext] = value;
        this.#inext = inext;
        this.#inextp = inextp;

        return value;
    }
}

export function getManiaRandomSeed(mods) {
    if (!mods || !Array.isArray(mods.array)) return null;

    const randomMod = mods.array.find((mod) => mod?.acronym === 'RD');
    const seed = randomMod?.settings?.seed;

    return Number.isInteger(seed) && seed >= INT32_MIN && seed <= INT32_MAX ? seed : null;
}

// lazer shuffles over TotalColumns: up to 18 on native maps and 20 on Dual Stages converts.
export function createManiaRandomColumnMap(keyCount, seed) {
    if (!Number.isInteger(keyCount) || keyCount < 1 || keyCount > 20) {
        throw new RangeError('keyCount must be an integer from 1 through 20');
    }
    if (!Number.isInteger(seed) || seed < INT32_MIN || seed > INT32_MAX) {
        throw new RangeError('seed must be a signed 32-bit integer');
    }

    const random = new CsharpRandom(seed);
    const columns = Array.from({ length: keyCount }, (_, column) => column);
    const keys = new Int32Array(keyCount);

    for (let column = 0; column < keyCount; column++) {
        keys[column] = random.next();
    }

    columns.sort((left, right) => keys[left] - keys[right] || left - right);

    return columns;
}
