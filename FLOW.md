# How requests and processes flow between the agent and the WordPress instance

Two processes on the agent's machine — the **MCP server** (`x-agent`) and a **warm headless
Chromium** it drives — talk to one WordPress instance running **x-companion**. Everything
crosses the wire as authenticated REST; nothing on the instance ever calls out.

```mermaid
flowchart LR
    subgraph AGENT["Agent machine"]
        LLM["Claude Code\n(wp-blocks skill)"]
        MCP["x-agent MCP server\n17 tools, stdio"]
        BR["Warm Chromium\n(Playwright)"]
        PG["Throwaway Playground\n(wp_block_build_test only)"]
        LLM -- "tool calls" --> MCP
        MCP -- "drives" --> BR
        MCP -- "boots per build-test" --> PG
    end

    subgraph WP["WordPress instance (x-companion)"]
        REST["/x-companion/v1/*\ncapability + posture gate"]
        HARNESS["GET /harness\nblock registry + window.__compile()"]
        MEDIA["media library\n(placeholders, images)"]
        DB[("posts / global styles /\ninstalled agent blocks")]
    end

    MCP -- "Basic auth REST\n(fingerprint, manifest, validate,\nrender, parse, patterns, tokens,\ninstall, snapshot, placeholder)" --> REST
    BR -- "loads once per epoch" --> HARNESS
    REST --> MEDIA
    REST --> DB
```

The **epoch** (the instance fingerprint) is the consistency mechanism: every tree the agent
sends carries it, and the companion refuses trees generated against a stale world
(`E_EPOCH_MISMATCH`). The agent's own actions — installing a block, writing tokens — move it.

## The build loop (R5): prompt → published page

```mermaid
sequenceDiagram
    participant A as Agent (MCP tools)
    participant C as Companion REST
    participant H as Harness page (warm Chromium)

    A->>C: GET /fingerprint + GET /manifest (wp_connect)
    C-->>A: posture, fingerprint = EPOCH, blocks, tokens
    A->>C: GET /patterns (retrieve before inventing)
    C-->>A: parsed_tree corpus for this theme
    Note over A: generate TreeIR (JSON, never markup)<br/>epoch stamped on the tree
    A->>C: POST /validate (tree)
    C-->>A: valid + diagnostics (attr/nesting/epoch checks)
    A->>H: window.__compile(tree)  (wp_compile)
    Note over H: each block's own save()<br/>produces the markup
    H-->>A: canonical markup, all_valid, registry_gaps
    A->>H: render + measure (wp_verify)
    H-->>A: box_tree, a11y_outline, diffs — numbers, not pixels
    A->>C: POST /wp/v2/pages (publish markup)
    A->>H: one wp_screenshot — terminal evidence, never a loop input
```

## The vocabulary factory (R7 rung 3): a new block becomes vocabulary

```mermaid
sequenceDiagram
    participant A as Agent
    participant L as Local machine
    participant C as Companion REST

    A->>L: wp_block_scaffold → block.json + render.php + edit.js
    Note over A,L: agent implements render.php;<br/>edit.js is an inline-editable 1:1 mirror<br/>(RichText for text, MediaPlaceholder for images)
    A->>L: wp_block_build_test
    Note over L: wp-scripts build → throwaway Playground →<br/>register, render sample attrs, zip.<br/>THE safety gate — nothing ships without it
    L-->>A: built ✓ registered ✓ zip
    A->>C: POST /blocks/install (zip)
    C-->>A: NEW fingerprint — the epoch moved
    Note over A: every subsequent tree carries the new epoch;<br/>the block is now vocabulary like any core block
```

## Images before assets exist: placeholder + intent

```mermaid
sequenceDiagram
    participant A as Agent
    participant C as Companion REST
    participant G as Image-gen pass (later)

    A->>C: POST /placeholder {color: "accent-2"}
    C-->>A: {id, url} — idempotent 1×1 GIF on the palette
    Note over A: image node: url + width/aspectRatio/scale<br/>+ metadata.imageIntent = "what belongs here"<br/>Geometry is final; pixels are provisional
    A->>C: validate → compile → publish (intent rides in the block delimiter)
    G->>C: POST /parse (published content)
    C-->>G: tree with metadata.imageIntent leaves
    Note over G: generate/source each asset, upload,<br/>swap url/id on the node, recompile
    G->>C: publish updated markup — layout never moved
```

## The posture wall

Every mutating route sits behind the extend tier, and the extend tier is hard-disabled on a
`production` instance — before the request body is parsed, regardless of the caller's
capabilities:

```mermaid
flowchart TD
    REQ["extend-tier request\n(tokens, install, snapshot, placeholder)"] --> AUTH{authenticated?}
    AUTH -- no --> E401["401 rest_forbidden"]
    AUTH -- yes --> POST{posture?}
    POST -- production --> E403["403 posture_forbidden\n'snapshot to a sandbox, promote artifacts'"]
    POST -- toolchain --> CAP{x_companion_extend?}
    CAP -- no --> E403b["403 rest_forbidden_capability"]
    CAP -- yes --> RUN["handler runs"]
```

The intended shape of work follows from the wall: **fabricate on a toolchain sandbox, verify
numerically, export with `wp_snapshot`, promote the artifact** — production receives results,
never the toolchain.
