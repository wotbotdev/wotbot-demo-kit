# WoTBot demo kit

Reusable runtime pieces for WoTBot demos. Version `0.1.2` contains the AI Mock
adapter and read-only WoT Thing Description Directory. Each demo owns its TDs,
participant manifest, recordings, prompts, data services, and Compose wiring.

## Shared components

- `aimock/wotbot-aimock.mjs` adds proxy, record, hybrid, replay, and rekey
  modes around CopilotKit AI Mock. It handles OpenAI and OpenRouter upstreams,
  stable request matching, ID remapping, request dumps, and replay speed.
- `aimock/rewrite-aimock-fixtures.mjs` updates recorded fixtures after text
  changes. Run it from a demo repository root so paths resolve there.
- `directory/wot_directory.py` implements the three read-only endpoints used by
  WoTBot's `wot-tdd` provider. `manifest_directory.py` serves a participant
  selected from a demo-owned JSON manifest.

For local development, build the versioned images with:

```sh
make build
```

GitHub Actions builds and checks both images on pushes, pull requests, and
manual runs. Pushing a `v<version>` tag matching `VERSION` also publishes
multi-platform images to GHCR:

- `ghcr.io/wotbotdev/wotbot-demo-kit-aimock:<version>`
- `ghcr.io/wotbotdev/wotbot-demo-kit-directory:<version>`

The images contain the pinned public base layers and kit runtime code; demo
fixtures, TDs, and credentials are not part of the build context. Both demos
pin the published `0.1.2` images and pull them as needed. A sibling kit
checkout is useful for changing shared code or rewriting recorded fixtures.
Both Dockerfiles pin their upstream image digests for repeatable builds.

The shared runtime code stays in these images; each demo mounts only its own
configuration, participant code, TDs and fixtures. To rewrite a demo's recorded
fixtures, run the kit script from that demo's root:

```sh
node ../wotbot-demo-kit/aimock/rewrite-aimock-fixtures.mjs <rules.json>
```

Change `VERSION`, rebuild both images, and update demo Compose references when
releasing shared behavior. Commit and tag the kit revision before using the
new image tag.

## Configuration

AI Mock expects `/fixtures` for recordings and `/requests` for optional request
dumps. `AIMOCK_MODE=live` is accepted as an alias for `proxy` for older Data
Summit setups. `AIMOCK_PROVIDER` is `openai` or `openrouter`.
`AIMOCK_UPSTREAM_URL` specifies a provider origin; the older
`AIMOCK_UPSTREAM_BASE_URL` setting accepts an OpenAI-compatible `/v1` base URL.
The upstream key is `AIMOCK_UPSTREAM_API_KEY`.

The manifest directory expects `PARTICIPANT_KEY` and
`PARTICIPANT_BASE_URL`. `PARTICIPANT_MANIFEST` points to the demo's JSON
manifest and `PARTICIPANT_TD_DIR` to its TD directory. A manifest entry has
`service`, `title`, `description`, `tags`, and a list of TD filenames in
`things`. The directory image serves metadata only; TD forms may call other
services.

## Checks

```sh
make check
```

Each demo also runs its own manifest and Compose checks.

## License

MIT. See [LICENSE](LICENSE).
