# Computer Use API Contract

**Status:** Draft v0.2 contract

## Design goal

The Computer Use API should expose a stable, structured domain contract over MCP.
MCP remains the transport; the Computer Use contract defines state, targets, actions,
receipts, errors, capabilities, and OCR providers.

The goal is to match Codex's useful semantic behavior—not to reproduce its private
Sky transport or implementation.

## Layering

```text
MCP / JSON-RPC transport
  └── Computer Use domain contract
        ├── AppState
        ├── ElementTarget
        ├── ActionReceipt
        ├── ComputerUseError
        ├── Capabilities
        └── OCRProvider
              ├── Vision (local)
              └── HTTP/API provider (opt-in)
```

The macOS backend should not know whether the caller is Pi, Codex, Claude, or a
standalone CLI. Host policy and confirmation decisions belong above the backend.

## MCP result shape

Every successful tool call should return structured data. For clients that support
MCP structured tool results, use `structuredContent` plus concise human-readable
`content`. For older clients, serialize the same object into a JSON text block.

```json
{
  "content": [
    {
      "type": "text",
      "text": "Clicked the LinkedIn search control."
    }
  ],
  "structuredContent": {
    "ok": true,
    "requestId": "cu_01J...",
    "action": {
      "kind": "click",
      "target": {
        "source": "ax-exact",
        "role": "AXButton",
        "label": "Search"
      },
      "settled": true
    },
    "state": {
      "stateVersion": 12,
      "app": {
        "bundleId": "com.google.Chrome",
        "displayName": "Google Chrome",
        "pid": 1234
      }
    }
  }
}
```

Errors should use MCP `isError: true` and also provide a structured error object.

## Common envelope

```json
{
  "ok": true,
  "requestId": "cu_01J...",
  "warnings": [],
  "action": null,
  "state": null,
  "error": null
}
```

Fields:

| Field | Meaning |
|---|---|
| `ok` | Whether the requested operation completed successfully. |
| `requestId` | Correlates logs and multi-step operations. Never contains user data. |
| `warnings` | Non-fatal issues such as partial AX data or OCR fallback. |
| `action` | Receipt for a mutating UI operation. |
| `state` | App state returned when requested or useful for the next action. |
| `error` | Structured retry/refresh information when `ok` is false. |

## App state

`get_app_state` is the primary observation tool. It should return structured state,
not only a preformatted accessibility string.

```json
{
  "stateVersion": 12,
  "capturedAt": "2026-08-16T21:00:00Z",
  "app": {
    "bundleId": "com.tinyspeck.slackmacgap",
    "displayName": "Slack",
    "pid": 4321,
    "isFrontmost": true
  },
  "window": {
    "id": 9988,
    "title": "#p-roi - AirOps - Slack",
    "focused": true,
    "bounds": { "x": 0, "y": 23, "width": 1440, "height": 877 }
  },
  "accessibility": {
    "format": "tree",
    "text": "@e1 ...",
    "tree": {
      "ref": "e1",
      "role": "AXWindow",
      "children": []
    },
    "refsVersion": 12,
    "partial": false
  },
  "screenshot": {
    "available": true,
    "mimeType": "image/png",
    "width": 1440,
    "height": 877,
    "contentRef": "image_01J..."
  },
  "ocr": {
    "status": "not_requested"
  }
}
```

### State rules

- `stateVersion` increases whenever a new tree or screenshot state is captured.
- Refs are valid only for the corresponding app/window and `refsVersion`.
- Screenshots should be returned as MCP image content when requested; `contentRef`
  is metadata, not a permanent filesystem path.
- A response may include a compact text tree for model usability and a structured
  tree for deterministic targeting.
- `partial: true` must be set when the AX tree is truncated or inaccessible.

## Target model

Targets should be a tagged union rather than a single ambiguous query string.

```json
{ "kind": "ref", "ref": "e42", "refsVersion": 12 }
```

```json
{
  "kind": "element",
  "role": "AXButton",
  "label": "Search",
  "identifier": "global-search",
  "windowId": 9988
}
```

```json
{
  "kind": "query",
  "text": "p-roi",
  "role": "AXRow",
  "exact": true,
  "windowId": 9988
}
```

```json
{
  "kind": "point",
  "x": 412,
  "y": 238,
  "coordinateSpace": "screen",
  "source": "ocr",
  "confidence": 0.94
}
```

Resolution order:

1. Current ref with matching `refsVersion`.
2. Accessibility identifier.
3. Exact role + label/value/description.
4. Exact text with window/ancestor context.
5. Structured query.
6. Unique substring fallback.
7. OCR point only when confidence and geometry checks pass.

Ambiguous targets must return an error with candidates instead of selecting the
first result silently.

## Action receipt

Every mutating action should return a receipt:

```json
{
  "id": "act_01J...",
  "kind": "click",
  "target": {
    "source": "ref",
    "ref": "e42",
    "role": "AXButton",
    "label": "Search",
    "bounds": { "x": 400, "y": 220, "width": 80, "height": 32 }
  },
  "method": "AXPress",
  "startedAt": "2026-08-16T21:00:00Z",
  "durationMs": 84,
  "settled": true,
  "stateChanged": true,
  "stateVersion": 13
}
```

Possible `method` values include:

```text
AXPress
AXSetValue
AXSecondaryAction
CGEvent
OCRCoordinate
ClipboardPaste
```

The receipt makes fallbacks visible to the agent and useful for debugging.

## Error contract

```json
{
  "code": "STALE_REF",
  "message": "Element ref e42 belongs to refsVersion 11; current state is 12.",
  "retryable": true,
  "requiresStateRefresh": true,
  "details": {
    "app": "com.tinyspeck.slackmacgap",
    "expectedRefsVersion": 11,
    "currentRefsVersion": 12
  }
}
```

Initial error codes:

```text
APP_NOT_FOUND
WINDOW_NOT_FOUND
APP_NOT_FRONTMOST
ACCESSIBILITY_PERMISSION_REQUIRED
SCREEN_RECORDING_PERMISSION_REQUIRED
ELEMENT_NOT_FOUND
AMBIGUOUS_TARGET
STALE_REF
FOCUS_NOT_VERIFIED
ACTION_UNAVAILABLE
ACTION_FAILED
SETTLE_TIMEOUT
OCR_UNAVAILABLE
OCR_LOW_CONFIDENCE
REMOTE_OCR_NOT_ALLOWED
INTERNAL_ERROR
```

Errors should say whether the agent can retry, refresh state, activate the app, ask
the user for permission, or hand off an action.

## Capabilities

The server should advertise backend capabilities during initialization or through a
capabilities tool:

```json
{
  "backend": "macos-ax-cgevent",
  "version": "0.2.0",
  "capabilities": {
    "accessibilityTree": true,
    "structuredTree": true,
    "screenshots": true,
    "setValue": true,
    "selectText": true,
    "secondaryActions": true,
    "ocr": true,
    "ocrProviders": ["vision", "http"],
    "remoteOcr": false
  }
}
```

The agent must not assume optional capabilities exist.

## OCR provider contract

OCR should support local and third-party providers behind the same interface.

```json
{
  "provider": "vision",
  "image": {
    "source": "current_state",
    "region": { "x": 0.1, "y": 0.1, "width": 0.5, "height": 0.3 }
  },
  "languages": ["en-US"],
  "recognitionLevel": "fast",
  "allowRemote": false
}
```

Provider results should be normalized:

```json
{
  "provider": "http:example-ocr",
  "tokens": [
    {
      "text": "p-roi",
      "confidence": 0.94,
      "bounds": { "x": 0.12, "y": 0.42, "width": 0.08, "height": 0.03 }
    }
  ],
  "latencyMs": 420,
  "remote": true
}
```

### Provider policy

- Local Vision should be the default provider on macOS.
- HTTP/API providers must be explicit configuration, not silently selected.
- API keys belong in environment variables, the keychain, or host-managed secrets;
  never in tool arguments or logs.
- Sending a screenshot to a third party must honor the host's privacy policy and
  confirmation rules.
- Remote OCR should be disabled when the image may contain credentials, private
  messages, customer data, or other sensitive information unless the user has
  authorized the specific destination and data.
- The OCR response must identify `provider`, `remote`, `confidence`, and latency.

## Versioning

- Keep MCP tool names stable where possible.
- Add optional fields before changing required fields.
- Include a contract version in capabilities, not in every tool name.
- Preserve a compact text fallback for clients that do not expose structured content.
- Treat structured response fields as the compatibility surface; internal Swift
  types and provider implementations may evolve independently.
