# OCR Strategy

**Status:** Draft decision record for Computer Use v0.2

## Decision

OCR should be a **fallback capability**, not the primary way the agent understands
macOS applications.

The preferred order is:

1. Native accessibility tree and AX attributes.
2. App/window screenshot for visual verification.
3. OCR over a bounded screenshot region when AX does not expose useful text.
4. Coordinate interaction only when OCR text and geometry provide a sufficiently
   confident target.

For the first macOS implementation, use Apple's **Vision framework** rather than
bundling a separate model. `VNRecognizeTextRequest` gives us local OCR without a
model download, Python runtime, or large dependency. It also keeps the backend
consistent with the project's macOS-only scope.

A pluggable OCR interface should still be added so a lightweight ML model can be
introduced later if Vision is insufficient for a particular app or language.

## Why AX remains primary

Accessibility provides information OCR cannot reliably infer:

- element role
- enabled/disabled state
- focus state
- available actions
- editable versus read-only semantics
- hierarchical parent/child relationships
- stable labels and accessibility identifiers
- direct AX values

OCR sees pixels. It cannot tell whether text is a button, a label, a message, or a
security warning without additional heuristics. It is also vulnerable to zoom,
font rendering, theme, animation, and localization changes.

## Where OCR helps

OCR is especially useful when an app exposes poor or incomplete accessibility data:

- canvas-based web applications
- custom-rendered controls
- remote desktop sessions
- terminal-like or game-like surfaces
- virtualized lists
- image-heavy dashboards
- browser content that Chrome exposes as an opaque region
- Slack/LinkedIn states where visual text is visible but AX labels are missing

OCR should also be useful for verification: after an action, compare the screenshot
text against an expected heading or status rather than blindly trusting the action
result.

## Proposed interface

Keep OCR behind a backend protocol rather than coupling the MCP layer to Vision:

```swift
struct OCRRequest {
    let image: CGImage
    let region: CGRect?
    let languages: [String]
    let recognitionLevel: OCRRecognitionLevel
}

struct OCRToken {
    let text: String
    let confidence: Float
    let normalizedBounds: CGRect
}

protocol OCRProvider {
    func recognize(_ request: OCRRequest) throws -> [OCRToken]
}
```

Initial provider:

```text
VisionOCRProvider
  → VNRecognizeTextRequest
  → OCRToken(text, confidence, normalizedBounds)
```

Possible later providers:

```text
MLXOCRProvider
OnnxOCRProvider
RemoteOCRProvider (opt-in only)
```

No remote provider should be enabled by default because screenshots can contain
credentials, private messages, customer data, or internal dashboards.

## OCR integration with Computer Use

### State capture

`get_app_state` should return the AX state first. If the caller requests visual
state, capture the window screenshot and optionally run OCR over it.

```json
{
  "screenshot": {
    "mimeType": "image/png",
    "data": "..."
  },
  "ocr": {
    "tokens": [
      {
        "text": "Search",
        "confidence": 0.98,
        "bounds": { "x": 0.12, "y": 0.04, "width": 0.10, "height": 0.03 }
      }
    ]
  }
}
```

OCR should be opt-in or automatically triggered only when:

- the AX tree is empty or suspiciously small;
- a requested label cannot be found in AX;
- the app is known to use custom rendering;
- visual verification was explicitly requested.

### Target resolution

OCR is not sufficient by itself to click safely. The resolver should:

1. Search AX elements first.
2. Search OCR tokens if AX matching fails.
3. Convert normalized OCR bounds to screenshot pixels.
4. Convert screenshot pixels to screen coordinates, accounting for Retina scale,
   window origin, and captured-window bounds.
5. Require a confidence threshold and reject ambiguous duplicate matches.
6. Return the target source as `ocr` so the agent can see that it used a fallback.

Example result:

```json
{
  "target": {
    "source": "ocr",
    "text": "p-roi",
    "confidence": 0.94,
    "screenBounds": { "x": 210, "y": 455, "width": 82, "height": 24 }
  }
}
```

## Vision configuration

Start with:

- `recognitionLevel = .fast` for polling and settle checks.
- `recognitionLevel = .accurate` for an explicit target lookup.
- Explicit recognition languages based on the active locale.
- Region-of-interest cropping whenever the target area is known.
- A short timeout so OCR never blocks normal AX interactions for a long period.

The implementation should expose timing and confidence in diagnostic logs, but not
log recognized text by default.

## Lightweight model assessment

A separate lightweight OCR model may be worthwhile later, but it should be added
only after measuring real failures from Vision.

### Reasons to add one

- Vision accuracy is inadequate for stylized or low-contrast UI text.
- The workflow needs language coverage unavailable in the installed Vision setup.
- A canvas exposes text in a form where a specialized model performs better.
- We need deterministic behavior across macOS versions.

### Reasons not to add one initially

- Model packaging increases release size and startup time.
- Inference adds memory and CPU pressure alongside Chrome/Slack.
- Model licenses and redistribution need review.
- A model can create false confidence without improving target geometry.
- The primary failures currently come from session/focus/tooling gaps, not OCR.

If a model becomes necessary, evaluate it behind `OCRProvider` using a small fixture
set from Chrome, Slack, LinkedIn, and canvas-style apps. Compare:

- text recognition accuracy
- token bounding-box accuracy
- latency
- peak memory
- architecture support (Apple Silicon and Intel if still required)
- language coverage
- license and redistribution terms

## Privacy and security

- OCR is local by default.
- Do not send screenshots to a remote provider without explicit user authorization.
- Do not persist OCR output beyond the Computer Use session unless requested.
- Redact or suppress OCR logs by default.
- Treat all OCR text as untrusted third-party UI content.
- OCR recognition must not bypass confirmation requirements for credentials,
  sensitive-data transmission, uploads, deletion, transactions, or settings.

## Acceptance criteria

OCR fallback is ready for v0.2 when:

- AX lookup remains the default and fastest path.
- Vision can recognize bounded UI regions locally.
- Screenshot-to-screen coordinate conversion is tested on Retina displays.
- Ambiguous OCR matches fail safely rather than clicking the first match.
- The state response identifies OCR-derived targets and confidence.
- No screenshot or OCR text is written to logs by default.
- A provider interface exists so a future lightweight model can be evaluated without
  changing MCP tool contracts.
