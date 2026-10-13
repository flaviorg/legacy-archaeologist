# Vendored: bytes 3.1.2

The second target of the demo: a small, real, MIT-licensed CommonJS module that nobody wrote for this project.

| Field | Value |
|---|---|
| Package | `bytes` |
| Version | 3.1.2 |
| Source | https://registry.npmjs.org/bytes/-/bytes-3.1.2.tgz |
| Obtained | 2026-10-13, with `npm pack bytes@3.1.2` into an empty folder (served from the local npm cache, checked by npm against the registry integrity below) |
| Tarball sha256 | `835e37ad5a40da45eaed6e32d99847627a15b2a4671741182521fe48dee3c581` |
| Tarball integrity (npm) | `sha512-/Nf7TyzTx6S3yRJObOAV7956r8cr2+Oj8AC5dt8wSP3BQAoeX58NoHyCU8P8zGkNXStjTSi6fzO6F0pBdcYbEg==` |
| `index.js` sha256 | `893fcbbbe962dc00e40dc2e4b20e76e92d874dd257345003c6575d940e91a37f` |
| License | MIT (`LICENSE`, copied from the package) |

Files copied unmodified: `index.js` (170 lines; `module.exports = bytes; module.exports.format = format; module.exports.parse = parse`) and `LICENSE`. `package.json` was replaced by a one-line type declaration (`{"type":"commonjs"}`), so the staged copy resolves the module type without the package's metadata. `Readme.md` and `History.md` were not copied.

`tests/unit/third-party.unit.test.ts` checks that `index.js` still has the sha256 above, that the license is MIT and that `package.json` declares CommonJS.
