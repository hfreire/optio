# Image presets

The `node` and `full` agent presets install `unzip` before running the Bun
installer. This is a build prerequisite and requires no runtime configuration.
Choose either preset when building agent images with `images/build.sh`.

## Custom image

A repo can run an image of your own instead of a preset: set **Custom image** in
the repo's settings (or `customImage` on `PATCH /api/repos/:id`) to a reference
such as `registry.example.com/optio-agent-esp-idf:v1@sha256:...`. It overrides
`imagePreset`; clear it to go back to the preset. Build it `FROM` the base agent
image so the agent tooling is present. Because it decides what runs alongside
the repo's secrets, only a deployment admin can set or change it.
