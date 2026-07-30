# Inventia UI Architecture Implementation

## Product intent

Inventia remains an inventory and business operating system. The interface must support dense business work without looking dense. Existing workflows, permissions, API bindings, theme controls, cards, buttons, and status semantics remain intact.

## Alignment system

- Use an 8px spacing rhythm, with 24px as the normal section and card padding.
- Use a responsive 12-column content grid on desktop, 6 columns on tablet, and one column on mobile.
- Keep the application shell at a 260px sidebar and 72px top bar.
- Keep primary controls at 40px high with a 10px radius.
- Keep cards at a 16px radius, one light border, and a soft 2px/8px shadow.
- Separate content with whitespace and hierarchy, not gradients, dark containers, or heavy outlines.
- Use existing theme tokens for all new surfaces and states. Purple remains limited to AI context.

## Page walkthrough

Every workspace follows the same reading order:

1. Breadcrumb and page identity.
2. Context, date, and primary action.
3. View navigation or tabs.
4. Summary metrics.
5. Primary working area or analytics.
6. Supporting records, alerts, activity, and AI insight.

This creates a predictable left-to-right and top-to-bottom path without changing business workflows.

## Shell

- Sidebar: organization switcher, grouped navigation, active state, collapse support, and status footer.
- Top bar: sidebar control, quick create, universal search / command palette, utility actions, notifications, theme, and profile.
- Content: bounded readable width with responsive gutters and no horizontal page overflow.

## Module composition

Each module should reuse:

- `.page-architecture-header` for breadcrumb, title, context, and actions.
- `.workspace-view-tabs` for local view navigation.
- `.kpi-card` for summary signals.
- `.grid-panel` for charts, tables, activity, timeline, documents, and AI insight.
- `.table-container` for sticky, scroll-safe data tables.
- `.action-btn` for all existing action hierarchy.

## Responsive behavior

- Desktop: 12-column dashboard and multi-panel workspaces.
- Tablet: panels collapse to six or twelve columns based on importance.
- Mobile: off-canvas sidebar, compact header, stacked page actions, horizontal local tabs, and scroll-safe tables.

## Implementation order

1. Normalize tokens and remove visually heavy override effects.
2. Apply the page header and 12-column alignment grammar to the dashboard.
3. Normalize existing workspace heroes and tables to the same component rules.
4. Verify light/dark mode, desktop/tablet/mobile, focus states, and current workflows.
