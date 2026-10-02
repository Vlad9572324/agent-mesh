# Agent Mesh social preview

[Launch readiness](../../github-launch.md) · [Project](../../../README.md)

[social-preview.svg](social-preview.svg) is the editable, self-contained source.
[social-preview.png](social-preview.png) is its opaque 1280 × 640 raster export,
prepared for a future explicitly approved GitHub social-preview update.

This is a conceptual brand card, not a product screenshot or live status view.
The three generic CLI participants illustrate independently operated agents
publishing shared messages, decisions, and reviews. It contains no provider
logos, customer data, generated testimonials, metrics, or third-party images.
Colors and system-font typography follow the existing documentation diagrams.
The artwork is repository-native SVG; the PNG is a renderer-generated export, not
an AI-generated image. No separate asset license is assigned here.

## Regenerate and check

The initial export used the host's already installed librsvg and Cairo shared
libraries. From the repository root, an installed librsvg command-line renderer
can regenerate the same canvas:

```sh
rsvg-convert --width 1280 --height 640 \
  --output docs/assets/brand/social-preview.png \
  docs/assets/brand/social-preview.svg
```

Rendering writes the PNG; do not hand-edit the exported pixels. This command
does not install the renderer. System fonts and renderer versions can change
rasterization. If using a browser instead, load only the local SVG in a fresh
temporary profile, use a 1280 × 640 viewport at device scale 1, and remove only
that owned profile after the browser exits. Never reuse a signed-in profile.

Inspect the complete PNG for clipped text or connectors. Confirm it is exactly
1280 × 640 and under 1 MB, and run `node scripts/check-docs.mjs`. The SVG must retain
its accessible title/description and contain no scripts, embedded images,
`foreignObject`, or external references. No live application, browser login,
model job, or production screenshot is needed to regenerate it.

## Upload remains pending

Nothing in this directory configures GitHub or confirms a successful upload.
Repository visibility and a preview upload are separate maintainer actions; do
not change visibility merely to enable an image. The prepared export is
1280 × 640 and under 1 MB.
[GitHub's social-preview guide](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview)
describes current availability and the Settings → Social preview controls.
Record the actual upload outcome separately from preparing this asset.
