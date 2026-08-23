/**
 * Editor UI for `agent/cancan-stats` — Numbers that dance.
 *
 * THE EDITOR CONTRACT — the canvas is the front end.
 *
 * The canvas previews the block through <ServerSideRender>: what the editor
 * shows IS render.php's output, by construction, and cannot drift as
 * render.php evolves. Every setting lives in the InspectorControls sidebar.
 *
 * The structured `stats` attribute is edited through a purpose-built rows
 * control — one field per property, add/remove rows — never raw JSON.
 */
import { __ } from '@wordpress/i18n';
import ServerSideRender from '@wordpress/server-side-render';
import { useBlockProps, InspectorControls } from '@wordpress/block-editor';
import { PanelBody, TextControl, Button, Flex, FlexItem } from '@wordpress/components';

function StatRows( { value, onChange } ) {
	const rows = Array.isArray( value ) ? value : [];

	const update = ( index, key, fieldValue ) => {
		const next = rows.map( ( row, i ) =>
			i === index ? { ...row, [ key ]: fieldValue } : row
		);
		onChange( next );
	};

	return (
		<>
			{ rows.map( ( row, index ) => (
				<div key={ index } style={ { marginBottom: '16px', paddingBottom: '8px', borderBottom: '1px solid #ddd' } }>
					<Flex gap={ 2 } align="flex-end">
						<FlexItem isBlock>
							<TextControl
								type="number"
								label={ __( 'Number', 'agent-cancan-stats' ) }
								value={ row.value ?? 0 }
								onChange={ ( v ) => update( index, 'value', v === '' ? 0 : Number( v ) ) }
							/>
						</FlexItem>
						<FlexItem>
							<TextControl
								label={ __( 'Sign after it', 'agent-cancan-stats' ) }
								value={ row.suffix ?? '' }
								onChange={ ( v ) => update( index, 'suffix', v ) }
							/>
						</FlexItem>
					</Flex>
					<TextControl
						label={ __( 'Caption underneath', 'agent-cancan-stats' ) }
						value={ row.label ?? '' }
						onChange={ ( v ) => update( index, 'label', v ) }
					/>
					<Button
						variant="secondary"
						isDestructive
						onClick={ () => onChange( rows.filter( ( _, i ) => i !== index ) ) }
					>
						{ __( 'Remove this number', 'agent-cancan-stats' ) }
					</Button>
				</div>
			) ) }
			<Button
				variant="primary"
				onClick={ () => onChange( [ ...rows, { value: 0, suffix: '', label: '' } ] ) }
			>
				{ __( 'Add a number', 'agent-cancan-stats' ) }
			</Button>
		</>
	);
}

export default function Edit( { attributes, setAttributes } ) {
	const blockProps = useBlockProps();

	return (
		<>
			<InspectorControls>
				<PanelBody
					title={ __( 'Numbers', 'agent-cancan-stats' ) }
					initialOpen={ true }
				>
					<StatRows
						value={ attributes.stats }
						onChange={ ( value ) => setAttributes( { stats: value } ) }
					/>
				</PanelBody>
				<PanelBody
					title={ __( 'Motion', 'agent-cancan-stats' ) }
					initialOpen={ false }
				>
					<TextControl
						type="number"
						label={ __( 'Count-up time (milliseconds)', 'agent-cancan-stats' ) }
						help={ __( 'How long the numbers take to reach their final value once seen.', 'agent-cancan-stats' ) }
						value={ attributes.duration_ms }
						onChange={ ( value ) => setAttributes( { duration_ms: value === '' ? undefined : Number( value ) } ) }
					/>
				</PanelBody>
			</InspectorControls>
			<div { ...blockProps }>
				<ServerSideRender
					block="agent/cancan-stats"
					attributes={ attributes }
					httpMethod="post"
					skipBlockSupportAttributes
				/>
			</div>
		</>
	);
}
