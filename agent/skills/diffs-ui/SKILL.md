---
name: diffs-ui
description: Build polished web UIs for rendering file diffs with the @pierre/diffs library. Use when creating or improving React or vanilla JavaScript diff viewers, code review panels, patch displays, merge conflict resolution screens, large virtualized diff lists, SSR-rendered diffs, token-hover code intelligence, or Shadow DOM styling for attractive file diff interfaces.
---

# Diffs UI

## Overview

Use `@pierre/diffs` as the rendering engine for code and file diffs instead of hand-rolling diff tables. Favor the high-level React components for app UIs, and use vanilla components only when the host project is not React.

The Diffs API is in early active development. Before coding against an installed version, inspect local package types or current docs for exact prop names.

## First Move

1. Identify the input shape: two file versions, a unified patch string, pre-parsed diff metadata, a single source file, or a merge-conflict file.
2. Choose the highest-level component that matches the input.
3. Build the surrounding product UI: file list, toolbar, filters, sticky headers, review status, copy/open actions, and responsive layout.
4. Style through supported props, CSS variables, render callbacks, and scoped `unsafeCSS` only where the Shadow DOM requires it.
5. Verify in a browser at desktop and mobile widths; check long lines, many files, empty diffs, renamed/deleted files, and dark/light themes.

## API Choice

- Use `MultiFileDiff` from `@pierre/diffs/react` when the app has old and new file contents and wants React to handle comparison.
- Use `parseDiffFromFile` from `@pierre/diffs` plus `FileDiff` from `@pierre/diffs/react` when you need to cache metadata, adjust language, accept/reject hunks, or render many file diffs from structured data.
- Use `PatchDiff` from `@pierre/diffs/react` for a direct unified patch string.
- Use `parsePatchFiles` from `@pierre/diffs` plus a list of `FileDiff` components for multi-file patches or PR-style patch payloads.
- Use `File` for a syntax-highlighted file without diff markers.
- Use `UnresolvedFile` only for merge conflict markers; treat it as experimental and uncontrolled in React.
- Use vanilla `FileDiff`, `File`, or `UnresolvedFile` from `@pierre/diffs` when the project is framework-free.

Read `references/diffs-library.md` for the API map, performance guidance, SSR/worker notes, and styling details.

## React Pattern

Keep Diffs focused on rendering while the app owns navigation, filtering, and review workflow.

```tsx
import { useMemo } from "react";
import { FileDiff } from "@pierre/diffs/react";
import { parseDiffFromFile, setLanguageOverride } from "@pierre/diffs";

export function DiffPanel({ before, after, path, language, darkMode }) {
  const fileDiff = useMemo(() => {
    const diff = parseDiffFromFile(
      { name: path, contents: before, cacheKey: `${path}:before` },
      { name: path, contents: after, cacheKey: `${path}:after` },
    );

    return language ? setLanguageOverride(diff, language) : diff;
  }, [before, after, path, language]);

  return (
    <section className="diff-panel">
      <FileDiff
        fileDiff={fileDiff}
        options={{
          theme: darkMode ? "pierre-dark" : "pierre-light",
          hunkSeparators: "line-info-basic",
          unsafeCSS: diffUnsafeCss,
        }}
        renderHeaderPrefix={() => <FileBadge path={path} />}
        renderHeaderMetadata={(metadata) => <DiffActions fileDiff={metadata} />}
      />
    </section>
  );
}
```

Adjust the exact props to the installed package version. Prefer stable surrounding UI composition over deep custom renderer work.

## Attractive Diff UI

- Give the diff viewer a clear information hierarchy: repository/context header, file navigator, selected file header, hunk content, and review actions.
- Use restrained surfaces around the Diffs component. A single bordered container or full-width panel is usually better than stacking decorative cards.
- Keep code readable: use a mono font for diff content, generous but compact line height, visible line numbers, and enough gutter contrast to scan additions/deletions.
- Make additions and deletions semantic but not harsh. Favor soft green/red backgrounds, stronger gutter indicators, and clear inline highlights.
- Use `renderHeaderPrefix`, `renderHeaderMetadata`, or `renderCustomHeader` for file icons, path chips, changed-line counts, comments, status, collapse controls, and open-file actions.
- Keep sticky headers and file navigation predictable for long reviews.
- Include states for no changes, binary/unsupported files, huge files, load errors, collapsed files, and theme switching.
- For code review tools, support keyboard navigation, line selection, comments or annotations, accept/reject actions when relevant, and copy/open affordances.

## Styling

Diffs renders in Shadow DOM, so ordinary page CSS may not reach internal rows. Start with component options and render callbacks, then use `unsafeCSS` for focused Shadow DOM overrides.

Use simple direct selectors for documented data attributes. Avoid fragile selectors such as `:nth-child()`, sibling combinators, bare tag selectors, or deeply nested structure. Keep `unsafeCSS` small and colocated with the diff component so future package upgrades are easier to audit.

Prefer built-in hunk separator styles before custom renderers:

- `line-info` for rounded separators with expansion controls.
- `line-info-basic` for compact full-width separators.
- `metadata` for patch-style `@@` metadata rows.
- `simple` for minimal separators.

## Performance

- Use cache keys on files/diffs when contents are stable across remounts.
- For large patches or many files, parse once, memoize results, progressively mount file diffs, and consider Diffs virtualization.
- Use `Virtualizer` from `@pierre/diffs/react` for long scroll containers; keep its metrics aligned with custom line/header heights.
- Use the worker pool for large diffs so Shiki highlighting does not block the main thread. Put render options controlled by the pool on the pool manager, not individual components.
- Enable token hooks only when needed. Token metadata increases DOM size.
- For SSR, use preloaders from `@pierre/diffs/ssr` and spread the returned object into the matching client component so hydration inputs stay identical.

## Validation

After implementation, run the app's typecheck/tests and inspect the result in a real browser. Confirm that syntax highlighting appears after load, Shadow DOM overrides apply in both themes, virtualization is nonblank while scrolling, long lines do not break layout, and mobile widths keep file paths/actions usable.
