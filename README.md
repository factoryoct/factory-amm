# Factory app

A concentrated-liquidity AMM on Octra: pools, swaps, liquidity and fees.

Runs at `app.factory-amm.xyz`. The landing site lives at `factory-amm.xyz` in its own repository.

## Build

    npm install
    npm run build

The output goes to `dist/`. The indexer endpoint is set in `.env.production`.

## Layout

    src/pages       swap, pool, liquidity, positions, protocol, admin
    src/components  shared interface parts
    src/utils       chain access, pricing, formatting
    src/config      token list and pool code hashes
    public          contract sources (.aml) and images

## Contracts

The .aml files in `public` are the sources of the live devnet contracts.
Each one compiles to the bytecode that is deployed, verified against the
chain:

    factory.aml      octFVpfuNb45oK9oWnE4ezhtzfFYzU8ddqAsq5p1RzBbDJd
    router.aml       octDVbwa9T7Gs5uDExSKw3rCH4sRkwy8M2qixXJJCBVTLc8
    quoter.aml       octAgXurs5zRbP88ASXNrKT5Evi7P4ozJNHFrS1YJHTRidf
    multihop.aml     octBF2q92ZHFE61CRKKgYQfoVGSbdy8yRsMebCcb6RQGR6n
    swaphelper.aml   oct2NP8nswgzWQ5Mt1ubRScuinyuK3fXdkAF8bEmKWTp6x7
    pool.aml         oct9dmE4kmoyeUzbKmk27GCgczGbv2MqKotDbmyvCAz182V
    woct.aml         oct4NZL1b4WoGoCtuNNyB6vtngmmvkfGHCYjkwgugX7AmsB
    fact.aml         oct8mCmYaMFN7LUDJwti87G6dXEdJraswXTzU4UfQ7LTF2W

To check one: compile it with the node's octra_compileAml method and compare
the sha256 of the bytecode with the code_hash that vm_contract returns for
the address.
    functions       Cloudflare Pages endpoints for /rpc and /price
