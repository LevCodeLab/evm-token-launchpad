# Contributing to evm-token-launchpad

Thanks for contributing. Bug fixes, gas improvements, and extra fuzz tests are always welcome.

## Local Setup

1. Copy `.env.example` to `.env`.
2. Run `npm install`.
3. Compile contracts with `npm run compile`.
4. Run `npm test` and `npm run deploy:local` before opening a pull request.

## Solidity and UI Rules

1. Keep `BondingCurveFactory` solvency checks intact (`_assertSolvency()`).
2. Never hardcode real private keys or mainnet wallet addresses in scripts or tests. Use `0x0000000000000000000000000000000000000000` placeholders or Hardhat signers.
3. Keep all web UI buttons and badges strictly monochrome (`#0B0B0E`, `#141418`, `#26262E`, `#FFFFFF`).
