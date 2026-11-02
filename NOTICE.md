# NOTICE

## Project status

This package is an offline recommendation-selection audit maintained as
`dsh-bili-audit`, derived from the original `dsh-bili-qq` project. The runtime
Bilibili client, QR login, favorite/comment mutations, channel delivery, QQ Bot
integration, wake scheduler, and their vendored dependencies have been removed.

An explicit, rate-limited, read-only metadata collector is shipped separately
under `scripts/crawl-bilibili.mjs`. The DSH runtime never imports or runs it.

## Third-party code

No third-party source code is vendored in this package. Runtime code depends
only on Node.js built-ins.

## License

The project is distributed under the MIT License. See `LICENSE`.
