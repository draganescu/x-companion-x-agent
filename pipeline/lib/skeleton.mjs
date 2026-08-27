// The skeleton vocabulary — dictated once by the ThemeSpec, obeyed everywhere.
// S1T shows it to the theme call; S4 payloads carry the chosen skeleton the way
// they carry the axis; S8 assembles split panes from it; S9 audits against it.

export const SKELETON_VOCABULARY = [
    'THE SKELETON (choose exactly one — the UI design style made architecture):',
    "- stacked: the classic vertical flow — header, a single column of full-width bands, footer. The default; most UI styles argue it.",
    "- split: the body is two persistent panes side by side (a primary flow and a secondary supporting column); each section later declares which pane it lives in. Choose it ONLY when the UI design style names a split/two-pane structure — 'Split Screen Layout' stops meaning 'a section with two columns in it'.",
    "- rail: a third template-part area — a persistent side rail beside the content column, populated by the furniture lane like the header and footer (the Sidebar Dashboard class). Choose it ONLY when the UI design style argues persistent side furniture.",
    'The skeleton is structure, not decoration: it decides templates and part areas. A skeleton the UI style does not argue is scope creep.',
].join('\n');

/** The pane a split-skeleton section tree declares on its root. */
export const SPLIT_PANES = ['primary', 'secondary'];

export function paneOf(tree) {
    const pane = tree?.blocks?.[0]?.attributes?.metadata?.pane;
    return typeof pane === 'string' ? pane : null;
}

/** Split-skeleton gate: the section root must declare its pane. */
export function screenPaneDeclaration(tree) {
    const pane = paneOf(tree);
    if (pane === null) {
        return [{ path: '/blocks/0/attributes/metadata', message: 'this is a SPLIT-skeleton site: the section root must declare its pane — attributes.metadata.pane set to "primary" or "secondary"' }];
    }
    if (!SPLIT_PANES.includes(pane)) {
        return [{ path: '/blocks/0/attributes/metadata/pane', message: `pane must be "primary" or "secondary", got "${pane}"` }];
    }
    return [];
}
