/**
 * Canned fixtures for the mock companion.
 *
 * The block subset is deliberately realistic: true attribute schemas taken from
 * the core registry shapes, real parent/ancestor relationships
 * (core/column -> core/columns, core/list-item -> core/list,
 * core/button -> core/buttons, core/post-template ancestor core/query), a mix of
 * dynamic and static blocks, and one agent/* block so install/vocabulary-gap
 * paths have something to point at.
 */

export interface MockBlock {
  title: string;
  category: string | null;
  api_version: number;
  attributes: Record<string, unknown>;
  supports?: Record<string, unknown>;
  parent?: string[] | null;
  ancestor?: string[] | null;
  provides_context?: Record<string, unknown>;
  uses_context?: string[];
  is_dynamic: boolean;
  variations_count?: number;
  agent_hints?: Record<string, unknown>;
}

export const MOCK_BLOCKS: Record<string, MockBlock> = {
  'agent/testimonial': {
    title: 'Testimonial',
    category: 'text',
    api_version: 3,
    attributes: {
      quote: { type: 'string', default: '' },
      author: { type: 'string', default: '' },
      rating: { type: 'number', default: 5 },
      variant: { type: 'string', enum: ['card', 'plain'], default: 'card' },
    },
    supports: { html: false, color: { background: true, text: true } },
    parent: null,
    ancestor: null,
    is_dynamic: true,
    variations_count: 0,
    agent_hints: { usage_notes: 'Installed via wp_block_install. Dynamic: markup comes from render.php.' },
  },
  'core/button': {
    title: 'Button',
    category: 'design',
    api_version: 3,
    attributes: {
      tagName: { type: 'string', enum: ['a', 'button'], default: 'a' },
      type: { type: 'string', default: 'button' },
      text: { type: 'string' },
      url: { type: 'string' },
      linkTarget: { type: 'string' },
      rel: { type: 'string' },
      placeholder: { type: 'string' },
      width: { type: 'number' },
      textAlign: { type: 'string' },
    },
    supports: { anchor: true, color: { text: true, background: true }, spacing: { padding: true } },
    parent: ['core/buttons'],
    ancestor: null,
    is_dynamic: false,
    variations_count: 0,
  },
  'core/buttons': {
    title: 'Buttons',
    category: 'design',
    api_version: 3,
    attributes: {
      layout: { type: 'object' },
      fontSize: { type: 'string' },
    },
    supports: { anchor: true, layout: true, spacing: { blockGap: true, margin: true } },
    parent: null,
    ancestor: null,
    is_dynamic: false,
    variations_count: 0,
    agent_hints: { allowed_blocks: ['core/button'] },
  },
  'core/column': {
    title: 'Column',
    category: 'design',
    api_version: 3,
    attributes: {
      verticalAlignment: { type: 'string', enum: ['top', 'center', 'bottom'] },
      width: { type: 'string' },
      allowedBlocks: { type: 'array' },
      templateLock: { type: ['string', 'boolean'], enum: ['all', 'insert', 'contentOnly', false] },
    },
    supports: { anchor: true, color: { background: true, text: true }, spacing: { padding: true } },
    parent: ['core/columns'],
    ancestor: null,
    is_dynamic: false,
    variations_count: 0,
  },
  'core/columns': {
    title: 'Columns',
    category: 'design',
    api_version: 3,
    attributes: {
      verticalAlignment: { type: 'string', enum: ['top', 'center', 'bottom'] },
      isStackedOnMobile: { type: 'boolean', default: true },
      templateLock: { type: ['string', 'boolean'], enum: ['all', 'insert', 'contentOnly', false] },
      align: { type: 'string' },
      style: { type: 'object' },
    },
    supports: { anchor: true, align: ['wide', 'full'], color: { background: true, text: true }, spacing: { blockGap: true, padding: true } },
    parent: null,
    ancestor: null,
    is_dynamic: false,
    variations_count: 5,
    agent_hints: { allowed_blocks: ['core/column'] },
  },
  'core/cover': {
    title: 'Cover',
    category: 'media',
    api_version: 3,
    attributes: {
      url: { type: 'string' },
      id: { type: 'number' },
      dimRatio: { type: 'number', default: 50 },
      overlayColor: { type: 'string' },
      minHeight: { type: 'number' },
      minHeightUnit: { type: 'string' },
      contentPosition: { type: 'string' },
      isDark: { type: 'boolean', default: true },
      align: { type: 'string' },
      layout: { type: 'object' },
    },
    supports: { anchor: true, align: true, spacing: { padding: true, margin: true } },
    parent: null,
    ancestor: null,
    is_dynamic: false,
    variations_count: 0,
  },
  'core/group': {
    title: 'Group',
    category: 'design',
    api_version: 3,
    attributes: {
      tagName: { type: 'string', default: 'div', enum: ['div', 'header', 'main', 'section', 'article', 'aside', 'footer'] },
      templateLock: { type: ['string', 'boolean'], enum: ['all', 'insert', 'contentOnly', false] },
      allowedBlocks: { type: 'array' },
      layout: { type: 'object' },
      align: { type: 'string' },
      style: { type: 'object' },
      backgroundColor: { type: 'string' },
      textColor: { type: 'string' },
    },
    supports: { anchor: true, align: ['wide', 'full'], layout: true, color: { background: true, text: true }, spacing: { blockGap: true, padding: true, margin: true } },
    parent: null,
    ancestor: null,
    is_dynamic: false,
    variations_count: 4,
  },
  'core/heading': {
    title: 'Heading',
    category: 'text',
    api_version: 3,
    attributes: {
      textAlign: { type: 'string', enum: ['left', 'center', 'right'] },
      content: { type: 'string', default: '' },
      level: { type: 'number', default: 2 },
      levelOptions: { type: 'array' },
      placeholder: { type: 'string' },
      fontSize: { type: 'string' },
      style: { type: 'object' },
      textColor: { type: 'string' },
    },
    supports: { anchor: true, className: false, color: { text: true, background: true }, typography: { fontSize: true } },
    parent: null,
    ancestor: null,
    is_dynamic: false,
    variations_count: 6,
  },
  'core/image': {
    title: 'Image',
    category: 'media',
    api_version: 3,
    attributes: {
      url: { type: 'string' },
      alt: { type: 'string', default: '' },
      caption: { type: 'string' },
      id: { type: 'number' },
      width: { type: 'string' },
      height: { type: 'string' },
      sizeSlug: { type: 'string' },
      linkDestination: { type: 'string' },
      align: { type: 'string' },
    },
    supports: { anchor: true, align: ['left', 'center', 'right', 'wide', 'full'], filter: { duotone: true } },
    parent: null,
    ancestor: null,
    is_dynamic: false,
    variations_count: 0,
  },
  'core/latest-posts': {
    title: 'Latest Posts',
    category: 'widgets',
    api_version: 3,
    attributes: {
      categories: { type: 'array' },
      postsToShow: { type: 'number', default: 5 },
      displayPostContent: { type: 'boolean', default: false },
      order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
      orderBy: { type: 'string', enum: ['date', 'title'], default: 'date' },
    },
    supports: { anchor: true, color: { background: true, text: true } },
    parent: null,
    ancestor: null,
    is_dynamic: true,
    variations_count: 0,
  },
  'core/list': {
    title: 'List',
    category: 'text',
    api_version: 3,
    attributes: {
      ordered: { type: 'boolean', default: false },
      values: { type: 'string', default: '' },
      type: { type: 'string' },
      start: { type: 'number' },
      reversed: { type: 'boolean' },
      placeholder: { type: 'string' },
    },
    supports: { anchor: true, color: { background: true, text: true }, typography: { fontSize: true } },
    parent: null,
    ancestor: null,
    is_dynamic: false,
    variations_count: 2,
    agent_hints: { allowed_blocks: ['core/list-item'] },
  },
  'core/list-item': {
    title: 'List item',
    category: 'text',
    api_version: 3,
    attributes: {
      placeholder: { type: 'string' },
      content: { type: 'string', default: '' },
    },
    supports: { anchor: true, className: false },
    parent: ['core/list'],
    ancestor: null,
    is_dynamic: false,
    variations_count: 0,
  },
  'core/paragraph': {
    title: 'Paragraph',
    category: 'text',
    api_version: 3,
    attributes: {
      align: { type: 'string' },
      content: { type: 'string', default: '' },
      dropCap: { type: 'boolean', default: false },
      placeholder: { type: 'string' },
      direction: { type: 'string', enum: ['ltr', 'rtl'] },
      fontSize: { type: 'string' },
      style: { type: 'object' },
      textColor: { type: 'string' },
      backgroundColor: { type: 'string' },
    },
    supports: { anchor: true, color: { text: true, background: true }, typography: { fontSize: true } },
    parent: null,
    ancestor: null,
    is_dynamic: false,
    variations_count: 0,
  },
  'core/post-template': {
    title: 'Post Template',
    category: 'theme',
    api_version: 3,
    attributes: { layout: { type: 'object' } },
    supports: { align: ['wide', 'full'], layout: true },
    parent: null,
    ancestor: ['core/query'],
    uses_context: ['queryId', 'query'],
    is_dynamic: true,
    variations_count: 0,
  },
  'core/query': {
    title: 'Query Loop',
    category: 'theme',
    api_version: 3,
    attributes: {
      queryId: { type: 'number' },
      query: { type: 'object' },
      tagName: { type: 'string', default: 'div' },
      namespace: { type: 'string' },
    },
    supports: { align: ['wide', 'full'], layout: true },
    parent: null,
    ancestor: null,
    provides_context: { queryId: 'queryId', query: 'query' },
    is_dynamic: true,
    variations_count: 3,
  },
  'core/separator': {
    title: 'Separator',
    category: 'design',
    api_version: 3,
    attributes: { opacity: { type: 'string', default: 'alpha-channel' }, align: { type: 'string' } },
    supports: { anchor: true, align: ['center', 'wide', 'full'], color: { background: true, text: false } },
    parent: null,
    ancestor: null,
    is_dynamic: false,
    variations_count: 0,
  },
  'core/site-title': {
    title: 'Site Title',
    category: 'theme',
    api_version: 3,
    attributes: {
      level: { type: 'number', default: 1 },
      textAlign: { type: 'string' },
      isLink: { type: 'boolean', default: true },
      linkTarget: { type: 'string', default: '_self' },
    },
    supports: { align: true, color: { background: true, text: true }, typography: { fontSize: true } },
    parent: null,
    ancestor: null,
    is_dynamic: true,
    variations_count: 0,
  },
  'core/spacer': {
    title: 'Spacer',
    category: 'design',
    api_version: 3,
    attributes: { height: { type: 'string', default: '100px' }, width: { type: 'string' } },
    supports: { anchor: true, spacing: { margin: ['top', 'bottom'] } },
    parent: null,
    ancestor: null,
    is_dynamic: false,
    variations_count: 0,
  },
};

export const MOCK_THEME_TOKENS = {
  color: {
    palette: [
      { slug: 'base', name: 'Base', color: '#ffffff' },
      { slug: 'contrast', name: 'Contrast', color: '#111111' },
      { slug: 'primary', name: 'Primary', color: '#1a4fd6' },
      { slug: 'accent-1', name: 'Accent 1', color: '#f5b301' },
    ],
  },
  spacing: {
    spacingSizes: [
      { slug: '20', name: '2X-Small', size: '0.5rem' },
      { slug: '30', name: 'X-Small', size: '1rem' },
      { slug: '40', name: 'Small', size: '1.5rem' },
      { slug: '50', name: 'Medium', size: '3rem' },
      { slug: '60', name: 'Large', size: '4.5rem' },
    ],
    spacingScale: { operator: '*', increment: 1.5, steps: 5, mediumStep: 1.5, unit: 'rem' },
  },
  typography: {
    fontSizes: [
      { slug: 'small', name: 'Small', size: '0.875rem' },
      { slug: 'medium', name: 'Medium', size: '1rem' },
      { slug: 'large', name: 'Large', size: '1.5rem' },
      { slug: 'x-large', name: 'Extra Large', size: '2.25rem' },
      { slug: 'xx-large', name: 'Extra Extra Large', size: '3.5rem' },
    ],
    fontFamilies: [
      { slug: 'body', name: 'Body', fontFamily: '"Inter", sans-serif' },
      { slug: 'heading', name: 'Heading', fontFamily: '"Playfair Display", serif' },
    ],
  },
  layout: { contentSize: '720px', wideSize: '1200px' },
};

export const MOCK_PATTERNS = [
  {
    name: 'twentytwentyfive/hero-centered',
    title: 'Centered hero with call to action',
    categories: ['banner', 'featured'],
    content:
      '<!-- wp:group {"align":"full","layout":{"type":"constrained"}} --><div class="wp-block-group alignfull"><!-- wp:heading {"textAlign":"center","level":1,"fontSize":"xx-large"} --><h1 class="wp-block-heading has-text-align-center has-xx-large-font-size">Ship the thing</h1><!-- /wp:heading --><!-- wp:paragraph {"align":"center","fontSize":"large"} --><p class="has-text-align-center has-large-font-size">A short supporting line.</p><!-- /wp:paragraph --><!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} --><div class="wp-block-buttons"><!-- wp:button --><div class="wp-block-button"><a class="wp-block-button__link wp-element-button">Get started</a></div><!-- /wp:button --></div><!-- /wp:buttons --></div><!-- /wp:group -->',
    parsed: [
      {
        blockName: 'core/group',
        attrs: { align: 'full', layout: { type: 'constrained' } },
        innerHTML: '',
        innerContent: [],
        innerBlocks: [
          {
            blockName: 'core/heading',
            attrs: { textAlign: 'center', level: 1, fontSize: 'xx-large' },
            innerHTML: '<h1>Ship the thing</h1>',
            innerContent: ['<h1>Ship the thing</h1>'],
            innerBlocks: [],
          },
          {
            blockName: 'core/paragraph',
            attrs: { align: 'center', fontSize: 'large' },
            innerHTML: '<p>A short supporting line.</p>',
            innerContent: ['<p>A short supporting line.</p>'],
            innerBlocks: [],
          },
          {
            blockName: 'core/buttons',
            attrs: { layout: { type: 'flex', justifyContent: 'center' } },
            innerHTML: '',
            innerContent: [],
            innerBlocks: [
              {
                blockName: 'core/button',
                attrs: { text: 'Get started' },
                innerHTML: '',
                innerContent: [],
                innerBlocks: [],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'twentytwentyfive/three-features',
    title: 'Three feature columns',
    categories: ['columns', 'featured'],
    content:
      '<!-- wp:columns {"align":"wide"} --><div class="wp-block-columns alignwide"><!-- wp:column --><div class="wp-block-column"><!-- wp:heading {"level":3} --><h3 class="wp-block-heading">Fast</h3><!-- /wp:heading --></div><!-- /wp:column --></div><!-- /wp:columns -->',
    parsed: [
      {
        blockName: 'core/columns',
        attrs: { align: 'wide' },
        innerHTML: '',
        innerContent: [],
        innerBlocks: [
          {
            blockName: 'core/column',
            attrs: {},
            innerHTML: '',
            innerContent: [],
            innerBlocks: [
              {
                blockName: 'core/heading',
                attrs: { level: 3 },
                innerHTML: '<h3>Fast</h3>',
                innerContent: ['<h3>Fast</h3>'],
                innerBlocks: [],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'twentytwentyfive/testimonial-card',
    title: 'Testimonial card',
    categories: ['text'],
    content:
      '<!-- wp:group {"style":{"spacing":{"padding":{"top":"var:preset|spacing|50"}}}} --><div class="wp-block-group"><!-- wp:paragraph --><p>It works.</p><!-- /wp:paragraph --></div><!-- /wp:group -->',
    parsed: [
      {
        blockName: 'core/group',
        attrs: { style: { spacing: { padding: { top: 'var:preset|spacing|50' } } } },
        innerHTML: '',
        innerContent: [],
        innerBlocks: [
          {
            blockName: 'core/paragraph',
            attrs: {},
            innerHTML: '<p>It works.</p>',
            innerContent: ['<p>It works.</p>'],
            innerBlocks: [],
          },
        ],
      },
    ],
  },
];

export const MOCK_SUITES = [{ slug: 'kadence-blocks', version: '3.2.29' }];

export const DEFAULT_FINGERPRINT = 'a'.repeat(64);
export const BUMPED_FINGERPRINT = 'b'.repeat(64);
