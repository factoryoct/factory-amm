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
    functions       Cloudflare Pages endpoints for /rpc and /price
