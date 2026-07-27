# Third-Party Notices

Ground Control for Codex includes unmodified portions of
[`mattpocock/skills`](https://github.com/mattpocock/skills) at revision
`ed37663cc5fbef691ddfecd080dff42f7e7e350d`.

Those files are vendored under `vendor/mattpocock-skills/` and installed as
project-local skills under `.agents/skills/`. The exact files and SHA-256
hashes are recorded in `release-lock.json`.

The upstream project is licensed under the MIT License:

> MIT License
>
> Copyright (c) 2026 Matt Pocock
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

Ground Control for Codex is an independent community project. It is not
affiliated with or endorsed by Matt Pocock or OpenAI.

## App runtime dependencies

The npm tarball bundles these direct runtime dependencies so the Codex App
integration can be installed and qualified without a registry connection:

- `@modelcontextprotocol/ext-apps@1.7.5` — MIT
- `@modelcontextprotocol/sdk@1.29.0` — MIT
- `zod@4.4.3` — MIT

Their transitive runtime dependencies use MIT, ISC, BSD-2-Clause, or
BSD-3-Clause licenses. Every bundled package retains its own `package.json`
license declaration and license file under the tarball's `node_modules/`
tree. Exact package versions and registry integrity hashes are recorded in
`package-lock.json` in the source repository.
