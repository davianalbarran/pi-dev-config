# Diffs Library Reference

Source: https://diffs.com/docs, reviewed 2026-05-07.

Diffs is a web library for rendering code and file diffs with Shiki-based syntax highlighting. It exposes high-level React and vanilla JavaScript components, lower-level renderers, SSR preloaders, worker-pool utilities, and parsing helpers. APIs are early and subject to change, so inspect installed types before final wiring.

## Package Exports

- `@pierre/diffs`: vanilla JS components plus utilities for parsing and rendering diffs.
- `@pierre/diffs/react`: React components.
- `@pierre/diffs/ssr`: server-side preload utilities for pre-rendered highlighted HTML.
- `@pierre/diffs/worker`: worker pool utilities for background syntax highlighting.

Install with the project's package manager:

```bash
npm install @pierre/diffs
```

## Core Data

- `FileContents`: a single file, typically `{ name, contents, cacheKey? }`. Use with `File`, `oldFile`, and `newFile`.
- `FileDiffMetadata`: structured diff metadata with hunks, line counts, and optionally full contents for expansion.
- Generate metadata with `parseDiffFromFile(oldFile, newFile, ...)` or `parsePatchFiles(patch, cacheKeyPrefix?, ...)`.
- Use `setLanguageOverride(fileOrDiff, language)` when filename detection is wrong or absent.

## React Components

Import from `@pierre/diffs/react`.

- `MultiFileDiff`: compare two file versions directly.
- `PatchDiff`: render a unified patch string.
- `FileDiff`: render pre-parsed `FileDiffMetadata`.
- `File`: render one syntax-highlighted file without diff markers.
- `UnresolvedFile`: render merge conflict markers with built-in resolution UI; beta/experimental and uncontrolled in React. Remount with a changing `key` to reset.
- `Virtualizer`: scroll container/context for virtualized `VirtualizedFile` and `VirtualizedFileDiff` rendering.
- `WorkerPoolContextProvider`: provide a worker pool to nested file and diff components.

Common diff callbacks/options:

- `options.collapsed`: hide file body while keeping the header visible.
- `renderHeaderPrefix(fileDiff)`: custom UI before default filename/icons.
- `renderHeaderMetadata(fileDiff)`: custom UI after built-in stats.
- `renderCustomHeader(fileDiff)`: replace built-in header content.
- Token callbacks on diff/file components: `onTokenClick`, `onTokenEnter`, `onTokenLeave`.
- Token callback payloads include `tokenText`, `lineNumber`, `lineCharStart`, `lineCharEnd`, `tokenElement`; diff variants also include `side`.

## Vanilla Components

Import from `@pierre/diffs`.

- `FileDiff`: compare old/new files or render parsed diff metadata.
- `File`: render one source file.
- `UnresolvedFile`: render merge conflicts. Vanilla supports uncontrolled notifications and controlled callbacks such as `onMergeConflictResolve` and `onMergeConflictAction`.
- `Virtualizer`, `VirtualizedFile`, and `VirtualizedFileDiff`: manually wire virtualized scroll behavior in vanilla apps.

Vanilla constructors accept an options object. Use header callbacks and `collapsed` similarly to React.

## Utilities

- `parseDiffFromFile`: compare two file versions and return `FileDiffMetadata`. It includes full contents, enabling expand-unchanged behavior.
- `parsePatchFiles`: parse unified diff or patch file content. Handles single and multi-commit patch payloads. A cache-key prefix can help worker-pool render caching.
- `trimPatchContext`: reduce large context windows while preserving valid diff headers.
- `diffAcceptRejectHunk`: accept, reject, or combine hunks/change blocks and return adjusted `FileDiffMetadata`.
- `resolveMergeConflict`: apply a merge-conflict resolution payload to file text.
- `preloadHighlighter`: preload themes/languages before rendering.
- `registerCustomTheme`: register a Shiki-compatible theme.
- `registerCustomLanguage`: register a custom Shiki language loader and optional filename/extension mapping.
- `getSharedHighlighter` / `disposeHighlighter`: access or free the shared Shiki highlighter.

## Hunk Separators

Use built-in `hunkSeparators` styles before custom rendering:

- `line-info`: rounded separator with collapsed-line count and expansion controls.
- `line-info-basic`: compact full-width separator with expansion controls.
- `metadata`: patch-style `@@ -x,y +a,b @@` row without expansion controls.
- `simple`: minimal separator bar.

The low-level `hunkSeparators(hunkData, instance)` render function exists in vanilla APIs but is being phased out. Avoid it for React, SSR, and virtualization-oriented integrations; style the built-in separator markup with `unsafeCSS` instead.

## Styling Shadow DOM

Diff and code components use Shadow DOM. Style in this order:

1. Surrounding app layout and component props.
2. CSS variables on a parent or the component.
3. Header render callbacks for product-specific UI.
4. `unsafeCSS` for small internal overrides.

`unsafeCSS` is injected into the shadow root in a high-priority layer. Keep it narrow, direct, and easy to delete. Prefer data-attribute selectors, and avoid structural selectors such as `:first-child`, `:last-child`, `:nth-child()`, sibling combinators, deeply nested selectors, and bare tag selectors.

Good uses for `unsafeCSS`:

- Align Diffs colors with the host app's light/dark theme.
- Tune addition/deletion/context backgrounds.
- Make headers sticky with a stable background.
- Adjust hunk separator spacing and icons.
- Set inherited font variables for headers and code.

## Themes

Bundled theme names include `pierre-light` and `pierre-dark`. Any Shiki theme can be used when supported by the installed package. Custom themes must be registered before rendering, and the registered name must match the theme JSON `name`.

Use a high-contrast code theme that matches the app chrome. For product UIs, avoid making the entire diff screen one saturated color; use neutral panels with semantic green/red diff accents.

## Token Hooks

Token hooks are experimental. Use them for hover cards, symbol navigation, LSP hover integration, or click-to-inspect interactions.

- Set `useTokenTransformer: true` when token wrappers or experimental selectors are needed without callbacks.
- Whitespace-only tokens are excluded unless `enableTokenInteractionsOnWhitespace` is true.
- If a worker pool is used, enable `useTokenTransformer` on `WorkerPoolManager`, not only on component options.
- Token metadata increases DOM size; avoid it on huge diffs unless the interaction is essential.

## Worker Pool

Use worker highlighting for large files, many diffs, or app shells where main-thread responsiveness matters.

- React: wrap diff components in `WorkerPoolContextProvider` from `@pierre/diffs/react`.
- Vanilla: use `getOrCreateWorkerPoolSingleton`, pass the pool to `File` or `FileDiff`, and call `terminateWorkerPoolSingleton` during cleanup when appropriate.
- Render options such as `theme`, `lineDiffType`, `tokenizeMaxLineLength`, and `useTokenTransformer` are controlled by the worker pool manager. Component-level values may be ignored while using a pool.
- Change pool render options with `setRenderOptions()`, which clears the render cache and re-renders mounted components.
- Workers need bundler-specific `workerFactory` setup. Vite may require `worker.format = "es"`. Next.js workers must run in client components.

## Virtualization

Virtualization is beta and opt-in. Use it for many files or very large diffs.

- React: wrap virtualized diff/file components in `Virtualizer`; it acts as the scroll container and provides context.
- Vanilla: create a `Virtualizer` instance and pass it to `VirtualizedFile` or `VirtualizedFileDiff`.
- Tune `metrics` when custom CSS changes line, header, or file heights.
- Use overscan to avoid blanking during scroll.
- Enable `resizeDebugging` only while tuning.
- Combine virtualization with a worker pool for large reviews.

## SSR

Import preloaders from `@pierre/diffs/ssr`.

- `preloadFile`: single file.
- `preloadUnresolvedFile`: merge-conflict file; experimental.
- `preloadFileDiff`: pre-parsed metadata.
- `preloadMultiFileDiff`: old/new contents.
- `preloadPatchDiff`: unified patch string for one file.
- `preloadPatchFile`: multi-file patch, returns one result per file.

Each preloader returns original inputs plus `prerenderedHTML`. Spread the whole result into the matching client component so hydration sees the same inputs used on the server. `onPostRender` still fires after hydration and later DOM commits.

## UI Checklist

- Provide a file tree or file list for multi-file patches.
- Expose changed-line totals and file status in headers.
- Keep selected file and sticky headers visible during scroll.
- Add toggles for unified/split display only if the installed Diffs version supports them.
- Add wrap/overflow controls for long lines.
- Preserve keyboard focus and visible focus rings inside surrounding UI.
- Use comments/annotations with stable identifiers tied to file path, side, and line number.
- Handle empty, binary, deleted, renamed, generated, and huge files.
- Confirm dark/light mode, mobile layout, and no-JS/SSR hydration states.
