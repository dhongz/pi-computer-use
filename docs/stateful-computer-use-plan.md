# Stateful Computer Use v0.2 Plan

**Status:** Draft
**Branch:** `plan/stateful-computer-use`
**Scope:** Pi-native Computer Use session, MCP API, macOS backend, and validation

## Summary

The current project has a working macOS automation backend, but its public API is
still too low-level for reliable agent use. The next version should behave like a
stateful Computer Use runtime rather than a collection of independent CLI commands.

The central design decision is:

> Pi should communicate with one persistent MCP Computer Use process per session.
> The process owns accessibility references, the latest app state, focus metadata,
> screenshot data, and action-settling behavior.

A Node REPL is not required. A persistent MCP server is sufficient and is the
preferred first implementation.

The proposed structured response and request contract is documented in
[`docs/api-contract.md`](api-contract.md). The implementation should expose
structured state and action receipts while retaining concise text content for
clients that do not render structured MCP results.

## Current gaps

The v0.1 backend currently has these limitations:

- The CLI starts a new process for every action, so `@eN` references cannot survive
  from one command to the next.
- `get_ax_tree` and `screenshot` are separate operations instead of one coherent
  app-state response.
- `type_text` and `key_press` synthesize global events without reliably targeting
  or verifying the intended app and field.
- `set_value`, `select_text`, and secondary accessibility actions are missing.
- Query matching is first-substring-wins and does not express role, scope, or
  parent context.
- Action completion requires ad-hoc sleeps instead of a settle/wait mechanism.
- Screenshots are returned as paths or base64 rather than as a state-level image
  attachment with metadata.
- The Pi MCP configuration has to be reloaded before the new server is visible;
  manual CLI testing does not exercise the intended persistent MCP path.

## Goals

1. Provide reliable app-scoped Computer Use tools from Pi.
2. Keep one persistent MCP process alive across tool calls.
3. Make accessibility state, screenshots, refs, and focus part of one session.
4. Prefer semantic AX actions and values before falling back to synthetic input.
5. Add screenshot/OCR fallback only where accessibility data is insufficient.
6. Preserve a useful CLI for diagnostics, smoke tests, and human debugging.
7. Keep the macOS backend independent from Pi-specific presentation and policy.
8. Make high-impact actions observable and compatible with Pi confirmation policy.

## Non-goals for v0.2

- Reimplementing Codex/Sky authentication or its proprietary service.
- Building a general cross-platform automation framework.
- Replacing Playwright for DOM-oriented browser automation.
- Adding a large bundled vision model before measuring the need.
- Automatically performing consequential actions without host-level policy.

## Target architecture

```text
Pi agent
  │
  │ persistent MCP stdio connection
  ▼
Pi Computer Use MCP server
  │
  ├── ComputerUseSession
  │     ├── active app/window
  │     ├── AX tree snapshots
  │     ├── stable session refs
  │     ├── focus state
  │     ├── screenshot metadata/data
  │     └── settle/wait state
  │
  ├── Tool facade
  │     ├── get_app_state
  │     ├── click / click_ref
  │     ├── type_text / set_value
  │     ├── select_text
  │     ├── press_key / scroll / drag
  │     ├── perform_secondary_action
  │     └── screenshot / OCR fallback
  │
  └── macOS backend
        ├── AXUIElement
        ├── CGEvent
        ├── CGWindowList
        ├── screencapture
        └── Vision OCR (fallback)
```

The CLI should call the same tool facade, but is explicitly diagnostic. Agent
workflows should use the persistent MCP server so session state is preserved.

## Session model

```swift
final class ComputerUseSession {
    var activeApp: AppIdentity?
    var activeWindow: WindowIdentity?
    var latestState: [AppIdentity: AppState]
    var refs: [AppIdentity: [ElementRef: AXUIElement]]
    var lastAction: ActionRecord?
}
```

### Reference lifecycle

- A tree dump creates refs for the active app/window.
- Refs remain valid until the next tree dump for that app/window, or until the
  underlying AX element becomes invalid.
- Every action response should identify whether the state changed.
- Stale refs should return a structured error asking the agent to refresh state.
- Query-based targeting remains available for stable controls.

## Proposed tool contract

The contract details for structured envelopes, state snapshots, targets, action
receipts, errors, capabilities, and OCR providers are in
[`docs/api-contract.md`](api-contract.md).

The MCP server may continue exposing unprefixed tool names; Pi will namespace them
as `pi-computer-use_*`.

| Tool | Purpose |
|---|---|
| `list_apps` | List running GUI apps with display name, bundle ID, PID, and running state. |
| `get_app_state` | Return accessibility text/tree plus optional screenshot for an app/window. |
| `click` | Click an element by structured target, query, or ref. Prefer AXPress. |
| `click_ref` | Click a ref from the current session state. |
| `drag` | Drag between element centers or screen coordinates. |
| `scroll` | Scroll over a target or at a specified location. |
| `press_key` | Send a key/combo scoped to an activated app. |
| `type_text` | Type into the currently verified focused field of an activated app. |
| `set_value` | Set an AX value directly when supported, otherwise use a safe input fallback. |
| `select_text` | Select text in an editable AX element, with cursor placement options. |
| `perform_secondary_action` | Invoke an action explicitly advertised by the AX element. |
| `wait_for` | Wait for a target or state predicate to appear. |
| `screenshot` | Return a screenshot attachment or diagnostic path. |
| `ocr` | Optional explicit OCR operation for a screenshot/region. |
| `clip_get` / `clip_set` | Read/write text clipboard data. |

### `get_app_state` response

The initial response should support both text-only and visual workflows:

```json
{
  "app": {
    "bundleId": "com.google.Chrome",
    "displayName": "Google Chrome",
    "pid": 1234
  },
  "window": {
    "title": "Example",
    "focused": true
  },
  "text": "@e1 standard window ...",
  "tree": { "ref": 1, "role": "AXWindow", "children": [] },
  "screenshot": {
    "mimeType": "image/png",
    "data": "..."
  },
  "refsVersion": 4,
  "settled": true
}
```

The screenshot should be optional to avoid unnecessary cost. The agent skill should
request it when the AX tree is incomplete, visually ambiguous, or required for
verification.

## Action semantics

Every mutating UI action should follow this sequence:

1. Resolve the app by display name, bundle ID, or path.
2. Activate the app when the action requires focus.
3. Resolve the target using ref, exact attributes, structured query, then bounded
   substring fallback.
4. Prefer AX actions/attributes.
5. Use CGEvent only as a documented fallback.
6. Wait for the app to settle or for the requested predicate.
7. Return an action result plus updated state metadata.

Keyboard actions must not silently leak to another app. If activation or focus
cannot be verified, return an error instead of sending a global event.

## Targeting strategy

Target resolution should be ordered from most deterministic to least deterministic:

1. Current-session ref.
2. Accessibility identifier.
3. Exact role + title/description/value.
4. Exact text within a specified window/region.
5. Query with parent/ancestor context.
6. Substring fallback, only when the result is unique.
7. Screenshot/OCR coordinates as a last resort.

The response should include the selected element's role, label, bounds, available
AX actions, and confidence/source (`ref`, `ax-exact`, `query`, or `ocr`).

## Implementation phases

### Phase 0 — Persistent MCP validation

- Restart Pi and verify `pi-computer-use` appears in the MCP server list.
- Confirm one server process handles multiple sequential calls.
- Add a protocol test that sends `initialize`, `tools/list`, `get_app_state`, and
  `click_ref` through the same process.
- Keep the CLI smoke test as a transport-only diagnostic.

**Exit criteria:** refs created by one MCP call can be consumed by a later MCP call.

### Phase 1 — Session and app state

- Add `ComputerUseSession` to `PiComputerUseMac`.
- Implement `get_app_state`.
- Return app/window metadata, AX text, optional structured tree, and screenshot data.
- Track refs per app/window and return a refs version.
- Add structured stale-ref and app-not-found errors.

**Exit criteria:** Chrome and Slack state can be inspected with one tool call and
refs can be reused reliably.

### Phase 2 — Correct interaction primitives

- Implement `set_value` using `AXUIElementSetAttributeValue` where supported.
- Add app-scoped `type_text` and `press_key`.
- Verify focus after activation and before synthetic input.
- Implement `select_text` and `perform_secondary_action`.
- Add drag support and improve key/modifier mapping.

**Exit criteria:** Chrome address-bar navigation and Slack channel search work
without global-input leakage.

### Phase 3 — Targeting, waiting, and screenshots

- Add exact/role-aware target resolution.
- Add `wait_for` predicates and settle detection.
- Return screenshots as MCP image content.
- Add screenshot region support.
- Add OCR fallback behind a capability check.

**Exit criteria:** LinkedIn and Slack workflows succeed from the persistent MCP
path without manual sleeps or coordinate guessing.

### Phase 4 — Pi integration and policy

- Update the canonical `computer-use` skill with the native MCP workflow.
- Keep Sky/direct Computer Use as an explicit fallback only.
- Document permissions and server reload behavior.
- Ensure the host can request confirmation for destructive, sensitive, or
  consequential actions.

**Exit criteria:** Pi can choose the native backend automatically and the skill does
not instruct the agent to use the CLI for normal Computer Use actions.

### Phase 5 — Hardening and release

- Add deterministic protocol tests.
- Add macOS integration fixtures where possible.
- Add structured logs to stderr with request IDs and timing.
- Add redaction for clipboard/OCR/screenshot diagnostics.
- Update release packaging and version to `0.2.0`.
- Publish a migration note from the v0.1 low-level API.

## Testing plan

### Protocol tests

- MCP initialize and capability negotiation.
- Tool schema validation.
- Persistent state across sequential calls.
- Stale ref errors.
- Invalid app/target errors.
- Screenshot content envelope.

### Backend tests

- AX attribute extraction.
- Target ranking and ambiguity handling.
- Modifier/key mapping.
- Screenshot window selection.
- OCR coordinate mapping.

### Manual integration matrix

| App | Read AX | Click | Type/set value | Keyboard | Screenshot | OCR fallback |
|---|---:|---:|---:|---:|---:|---:|
| Finder | ✓ | ✓ | — | ✓ | ✓ | optional |
| Chrome | ✓ | ✓ | ✓ | ✓ | ✓ | optional |
| Slack | ✓ | ✓ | ✓ | ✓ | ✓ | likely useful |
| LinkedIn | ✓ | ✓ | ✓ | ✓ | ✓ | likely useful |
| Canvas/web app | partial | partial | partial | ✓ | ✓ | important |

## Safety and privacy

- Accessibility, screenshots, clipboard, and OCR may expose sensitive data.
- Do not log raw screenshots, clipboard content, or OCR text by default.
- Keep screenshots in temporary storage with cleanup and clear ownership.
- Treat OCR output as untrusted UI content, not user authorization.
- Preserve Pi's confirmation policy for uploads, messages, credentials, settings,
  deletion, transactions, and other consequential actions.

## Open questions

1. Should `get_app_state` include screenshots by default or only on request?
2. Should structured trees be returned on every action or only when requested?
3. Should refs be per app, per window, or per state version?
4. Should the MCP process be `lazy-keep-alive` or explicitly session-scoped?
5. Which Slack/Chrome controls require AX value setting versus keyboard fallback?
6. How much OCR should be exposed as a public tool versus an internal fallback?
7. Do we need a small coordinate-click tool after OCR, or can OCR always map to an
   element/geometry target first?
