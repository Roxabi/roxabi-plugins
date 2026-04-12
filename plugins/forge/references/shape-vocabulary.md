# Shape Vocabulary

Semantic shapes for fgraph nodes. Claude reads this before generating
diagrams to pick the right shape modifier for each node.

## Node shapes

All shapes compose with tones (`amber`, `cyan`, `purple`, `green`, `red`),
sizes (`wide`, `narrow`), and content (`.fgraph-title`, `.fgraph-sub`, `.fgraph-pill`).

| Shape | Class | Semantic meaning | When to use | CSS technique |
|-------|-------|-----------------|-------------|---------------|
| Rounded rect | *(default)* | Service, process, generic component | Default for any node without a specific role | `border-radius: 12px` |
| Pill | `.pill` | Bus, broker, router, message queue | Central hub in radial diagrams, message-passing infrastructure | `border-radius: 999px` |
| Circle | `.circle` | Event, trigger, signal, start/end | Lifecycle points, webhooks, cron triggers, state machine start/end | `border-radius: 50%; aspect-ratio: 1` |
| Hexagon | `.hexagon` | Agent, worker, autonomous unit | AI agents, background workers, autonomous processes | `clip-path` polygon (6 sides) |
| Diamond | `.diamond` | Decision, gate, conditional, branch | Routing logic, feature flags, conditional paths, approval gates | `clip-path` polygon (4 sides rotated) |
| Cylinder | `.cylinder` | Database, storage, queue, cache | PostgreSQL, Redis, S3, any persistent data store | `border + ::before/::after` ellipse caps |
| Folded | `.folded` | File, config, document, static asset | Config files, templates, manifests, documentation | `clip-path` with corner notch |

## Arrow modifiers

Compose with tone classes on `.fg-edge` paths.

| Modifier | Class | Visual | When to use |
|----------|-------|--------|-------------|
| *(default)* | — | Solid 1.6px | Standard connection |
| Dashed | `.dashed` | `- - -` | Optional path, async, fallback, future/planned |
| Thick | `.thick` | Solid 2.8px | Primary data flow, critical path, hot path |
| Animated | `.animated` | Moving dashes | Live stream, active connection, real-time data |

Modifiers stack: `<path class="fg-edge amber thick animated" ...>`.

## Shape selection guide

When generating an fgraph diagram, pick shapes by asking:

1. **What does this node store?** → `.cylinder` (database) or `.folded` (file/config)
2. **Does this node decide or route?** → `.diamond`
3. **Does this node act autonomously?** → `.hexagon` (agent, worker)
4. **Is this node an event or signal?** → `.circle`
5. **Does this node relay or broker?** → `.pill`
6. **None of the above?** → default rounded rect

When generating arrows:

1. **Is this path always active in production?** → `.thick` if it's the critical path
2. **Is this path optional or async?** → `.dashed`
3. **Is this path a live stream?** → `.animated`
4. **Standard connection?** → no modifier
